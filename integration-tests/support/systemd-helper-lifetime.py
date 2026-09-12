import ctypes
import json
import os
import select
import signal
import socket
import struct
import subprocess
import sys
import time


def identity(pid):
    with open(f'/proc/{pid}/stat') as file:
        fields = file.read().rsplit(') ', 1)[1].split()
    return int(fields[1]), fields[19]


def prepare_signals():
    signal.signal(signal.SIGALRM, signal.SIG_IGN if request.get('ignored') else signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_BLOCK if request.get('blocked') else signal.SIG_UNBLOCK, [signal.SIGALRM])


def read_line(stream, timeout=5):
    if not select.select([stream], [], [], timeout)[0]:
        raise RuntimeError('Synthetic parent announcement deadline expired')
    return json.loads(stream.readline())


def reap_adopted_children():
    records = {}
    deadline = time.monotonic() + 5
    while True:
        with open(f'/proc/self/task/{os.getpid()}/children') as file:
            children = [int(pid) for pid in file.read().split()]
        if not children:
            return list(records.values())
        for pid in children:
            owner, start = identity(pid)
            if owner != os.getpid():
                raise RuntimeError('Cleanup child is not owned by the subreaper')
            record = records.setdefault(pid, {'pid': pid, 'startTicks': start, 'killed': False, 'reaped': False})
            observed, _ = os.waitpid(pid, os.WNOHANG)
            if observed == pid:
                record['reaped'] = True
            elif not record['killed']:
                os.kill(pid, signal.SIGKILL)
                record['killed'] = True
        if time.monotonic() >= deadline:
            raise RuntimeError('Adopted child cleanup deadline expired')
        time.sleep(0.01)


request = json.loads(sys.argv[1])
root = request['root']
mode = request['mode']
libc = ctypes.CDLL('libc.so.6', use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('Cannot establish the owning subreaper')

parent = None
peer = None
helper_pid = None
helper_start = None
rescued = []
listener = socket.socket(socket.AF_UNIX)
listener.bind(os.path.join(root, 'bus'))
listener.listen(1)
listener.settimeout(5)
started = time.monotonic()
result = {'mode': mode, 'subreaper': True}
try:
    if mode in ('watchdog', 'orphan', 'no-connect'):
        command = [request['bun'], '--no-env-file', '--config=/dev/null', request['parent'], root, mode]
        if request.get('executable'):
            command.append(request['executable'])
        parent = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  cwd=root, env={'BUN_OPTIONS': '--config=/dev/null'}, preexec_fn=prepare_signals)
        announced = read_line(parent.stdout)
        if announced['parentPid'] != parent.pid:
            raise RuntimeError('Synthetic parent identity mismatch')
        peer, _ = listener.accept()
        peer.settimeout(5)
        helper_pid, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        parent_pid, helper_start = identity(helper_pid)
        if parent_pid != parent.pid or uid != os.geteuid():
            raise RuntimeError('Authentication peer is not the exact helper child')
        with open(f'/proc/{helper_pid}/cmdline', 'rb') as file:
            if b'--internal-systemd-helper\x00' not in file.read():
                raise RuntimeError('Authentication peer has the wrong command')
        authentication = b''
        while b'AUTH EXTERNAL' not in authentication:
            chunk = peer.recv(1024)
            if not chunk or len(authentication) > 4096:
                raise RuntimeError('Helper did not begin native authentication')
            authentication += chunk
        result.update({'authenticated': True, 'helperPid': helper_pid, 'helperStartTicks': helper_start,
                       'workingDirectory': announced['workingDirectory']})
        if mode == 'watchdog':
            output, diagnostic = parent.communicate(b'expire\n', timeout=5)
            if parent.returncode != 0:
                raise RuntimeError(f'Synthetic parent failed: {diagnostic.decode()}')
            reply = json.loads(output)
            if reply != {'code': 'NODE_CLEANUP_TIMEOUT', 'timerCancelled': True}:
                raise RuntimeError(f'Unexpected parent deadline outcome: {reply}')
            if os.path.exists(f'/proc/{helper_pid}'):
                raise RuntimeError('Parent returned before exact helper reaping')
            result['parentDeadline'] = True
        else:
            parent.kill()
            if parent.wait(timeout=5) != -signal.SIGKILL:
                raise RuntimeError('Synthetic parent was not killed')
            deadline = started + 20
            while True:
                observed, status = os.waitpid(helper_pid, os.WNOHANG)
                if observed == helper_pid:
                    if not os.WIFSIGNALED(status) or os.WTERMSIG(status) != signal.SIGALRM:
                        raise RuntimeError(f'Helper did not exit through its kernel alarm: {status}')
                    result['helperSignal'] = 'SIGALRM'
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError('Orphaned helper exceeded its kernel deadline')
                time.sleep(0.01)
            result['adoptedAndReaped'] = True
        if peer.recv(1024) != b'':
            raise RuntimeError('Native authentication pipe did not close')
        result['socketClosed'] = True
        result['cwdContents'] = os.listdir(announced['workingDirectory'])
    else:
        parent = subprocess.Popen(request['command'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  cwd=request['cwd'], env={'BUN_OPTIONS': '--config=/dev/null',
                                  'DBUS_SESSION_BUS_ADDRESS': f'unix:path={root}/bus'}, preexec_fn=prepare_signals)
        helper_pid = parent.pid
        _, helper_start = identity(helper_pid)
        parent.wait(timeout=3 if mode == 'ffi' else 20)
        output, diagnostic = parent.communicate()
        if parent.returncode != -signal.SIGALRM:
            raise RuntimeError(f'Blocked helper did not exit through its alarm: {parent.returncode}, {diagnostic.decode()}')
        if mode == 'stdin' and (output or select.select([listener], [], [], 0)[0]):
            raise RuntimeError('Helper entered native bootstrap before stdin EOF')
        if mode == 'ffi' and output != b'armed\n':
            raise RuntimeError('Synthetic FFI call was not armed')
        result.update({'helperSignal': 'SIGALRM', 'noBootstrap': mode == 'stdin'})
    if os.path.exists(os.path.join(root, 'preload-ran')):
        raise RuntimeError('Ambient preload ran inside the helper')
    result['elapsedMs'] = round((time.monotonic() - started) * 1000)
finally:
    try:
        if parent and parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        rescued = reap_adopted_children()
        if rescued:
            print(json.dumps({'rescuedChildren': rescued}), file=sys.stderr)
    finally:
        if peer:
            peer.close()
        listener.close()
        if parent:
            for stream in [parent.stdin, parent.stdout, parent.stderr]:
                if stream:
                    stream.close()
if rescued:
    raise RuntimeError('Harness rescue-kill was required')
result['rescued'] = False
print(json.dumps(result))
