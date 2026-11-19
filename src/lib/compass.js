// Which way the phone is facing (0 = north, 90 = east), from the device's compass.
// Works offline. Android Chrome: 'deviceorientationabsolute'. iPhone Safari: webkitCompassHeading,
// after asking permission, which iOS only allows from inside a tap.

class Compass {
  constructor() {
    this.heading = null;
    this.listeners = new Set();
    this.state = 'off'; // off | on | denied | unsupported
  }

  /** Start listening. Call from a tap/click handler (iPhone needs that). Resolves true if it works. */
  enable() {
    if (this.state === 'on') return Promise.resolve(true);
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) {
      this.state = 'unsupported';
      return Promise.resolve(false);
    }
    // requestPermission must be called synchronously inside the tap, so no await before it
    const ask = typeof DOE.requestPermission === 'function' ? DOE.requestPermission() : Promise.resolve('granted');
    return ask
      .then((answer) => {
        if (answer !== 'granted') {
          this.state = 'denied';
          return false;
        }
        const handler = (e) => this.onEvent(e);
        if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler);
        else window.addEventListener('deviceorientation', handler);
        this.state = 'on';
        return true;
      })
      .catch(() => {
        this.state = 'denied';
        return false;
      });
  }

  onEvent(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h == null || Number.isNaN(h)) return;
    // the top of the screen points elsewhere when the phone is turned sideways
    const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
    h = (h + screenAngle + 360) % 360;
    // smooth out the jitter, going the short way round
    if (this.heading == null) this.heading = h;
    else this.heading = (this.heading + ((((h - this.heading) % 360) + 540) % 360 - 180) * 0.25 + 360) % 360;
    this.listeners.forEach((f) => f(this.heading));
  }

  on(f) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
}

export const compass = new Compass();
