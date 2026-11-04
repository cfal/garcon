package com.garconcloud.garcon

import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NavigationBoundaryTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    private fun evaluate(view: WebView, script: String): String {
        val done = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync {
            view.evaluateJavascript(script) { result = it; done.countDown() }
        }
        assertTrue("JavaScript result timed out", done.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun eventually(description: String, check: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            if (check()) return
            Thread.sleep(50)
        }
        fail(description)
    }

    private fun server() = MockWebServer().apply { start(InetAddress.getByName("0.0.0.0"), 0) }
    private fun url(server: MockWebServer, path: String) = "http://127.0.0.1:${server.port}$path"

    private fun takeRequest(server: MockWebServer, path: String): RecordedRequest? {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val request = server.takeRequest(100, TimeUnit.MILLISECONDS)
            if (request?.path == path) return request
        }
        return null
    }

    @Test
    fun hostRejectsConnectionsBeforeAndAfterActivityRecreation() {
        server().use { destination ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                repeat(2) { generation ->
                    if (generation > 0) scenario.recreate()
                    var webView: WebView? = null
                    eventually("Tauri WebView missing after recreation") {
                        scenario.onActivity { webView = findWebView(it.window.decorView) }
                        webView != null
                    }
                    val view = webView!!
                    eventually("Android launcher must remain disabled") {
                        evaluate(view, "document.querySelector('#connection-error')?.textContent.includes('Android build-only') && document.querySelector('#server-form button')?.disabled") == "true"
                    }
                    val targets = listOf("/allowed/", "/sibling/", "/allowed/redirect-307", "/allowed/redirect-308")
                        .map { url(destination, it) } + "file:///synthetic"
                    for (target in targets) {
                        evaluate(view, """
                            window.guardResult = null;
                            window.__TAURI_INTERNALS__.invoke('connect_server', {url: ${JSONObject.quote(target)}, generation: 0, acknowledged: false})
                              .then(() => window.guardResult = 'UNEXPECTED_SUCCESS', error => window.guardResult = String(error));
                        """.trimIndent())
                        eventually("Direct IPC must reject Android connection, including after recreation") {
                            evaluate(view, "window.guardResult?.includes('Android build-only')") == "true"
                        }
                    }
                    assertEquals("No connection attempt may reach a server", 0, destination.requestCount)
                }
            }
        }
    }

    // Exercises the Android callbacks used by pinned Wry, not a proposed production guard.
    private fun probe(intercept: Boolean, status: Int?, external: Boolean) {
        server().use { origin ->
            server().use { outside ->
                val destination = if (external) outside else origin
                val target = url(destination, "/sibling/escape")
                val action = if (status == null) target else url(origin, "/allowed/redirect")
                val dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                        "/allowed/start" -> MockResponse().setHeader("Content-Type", "text/html").setBody("""
                            <!doctype html><form method="POST" action="$action">
                            <input name="synthetic" value="payload"></form>
                        """.trimIndent())
                        "/allowed/redirect" -> MockResponse().setResponseCode(status!!).setHeader("Location", target)
                        "/sibling/escape" -> MockResponse().setHeader("Content-Type", "text/html").setBody("<!doctype html><title>escaped</title>")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
                origin.dispatcher = dispatcher
                outside.dispatcher = dispatcher
                lateinit var view: WebView
                instrumentation.runOnMainSync {
                    view = WebView(instrumentation.targetContext)
                    view.settings.javaScriptEnabled = true
                    val allowed = Uri.parse(url(origin, "/allowed/"))
                    fun disallowed(uri: Uri) = uri.authority != allowed.authority || !uri.path.orEmpty().startsWith("/allowed/")
                    view.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = disallowed(request.url)
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                            return if (intercept && request.isForMainFrame && disallowed(request.url)) {
                                WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
                            } else null
                        }
                    }
                    view.loadUrl(url(origin, "/allowed/start"))
                }
                try {
                    eventually("Synthetic POST form did not load") { evaluate(view, "!!document.querySelector('form')") == "true" }
                    assertEquals("GET", takeRequest(origin, "/allowed/start")?.method)
                    evaluate(view, "document.querySelector('form').submit()")
                    if (status != null) {
                        val redirect = takeRequest(origin, "/allowed/redirect")
                        assertEquals("/allowed/redirect", redirect?.path)
                        assertEquals("POST", redirect?.method)
                    }
                    val escaped = takeRequest(destination, "/sibling/escape")
                    assertNotNull("Expected the documented callback gap; if fixed, re-audit before enabling Android", escaped)
                    assertEquals("/sibling/escape", escaped?.path)
                    assertEquals("POST", escaped?.method)
                    assertEquals("synthetic=payload", escaped?.body?.readUtf8())
                } finally {
                    instrumentation.runOnMainSync { view.stopLoading(); view.destroy() }
                }
            }
        }
    }

    @Test
    fun navigationCallbackMissesDocumentPost() {
        for (external in listOf(false, true)) probe(false, null, external)
    }

    @Test
    fun partialRequestInterceptionMissesMethodPreservingRedirects() {
        for (status in listOf(307, 308)) {
            for (external in listOf(false, true)) probe(true, status, external)
        }
    }
}
