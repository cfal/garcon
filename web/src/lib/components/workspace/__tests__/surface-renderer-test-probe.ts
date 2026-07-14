class SurfaceRendererTestProbe {
	attached = 0;
	maximumAttached = 0;

	reset(): void {
		this.attached = 0;
		this.maximumAttached = 0;
	}

	attach(): void {
		this.attached += 1;
		this.maximumAttached = Math.max(this.maximumAttached, this.attached);
	}

	detach(): void {
		this.attached = Math.max(0, this.attached - 1);
	}
}

export const surfaceRendererTestProbe = new SurfaceRendererTestProbe();
