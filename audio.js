/**
 * AudioManager — 音频控制类
 *
 * - click / pluck：Howler Web Audio（需 AudioContext）
 * - 结算音乐 end：原生 <audio> 元素（不依赖 AudioContext）
 * - BGM：原生 <audio> 元素，由 AppCore 直接控制
 */
class AudioManager {
  constructor() {
    this._click = null;
    this._plucks = [];
    this._endEl = null;
    this._pluckIndex = 0;
    this._sharedLoaded = false;
  }

  /* ─────────── 加载共享音频（仅首次） ─────────── */

  async initSharedAudio(shared) {
    if (this._sharedLoaded) return;

    const loadPromises = [];

    this._click = new Howl({
      src: [shared.click],
      html5: false,
      preload: true,
      volume: 1.0,
      rate: 1.0,
    });
    loadPromises.push(this._waitForLoad(this._click));

    this._plucks = shared.pluck.map((src) => {
      const h = new Howl({
        src: [src],
        html5: false,
        preload: true,
        volume: 1.0,
        rate: 1.0,
      });
      loadPromises.push(this._waitForLoad(h));
      return h;
    });

    await Promise.all(loadPromises);
    this._sharedLoaded = true;
  }

  /* ─────────── 加载场景结算音频 ─────────── */

  async loadSceneAudio(scene) {
    // 清理旧的结算音频
    if (this._endEl) {
      this._endEl.pause();
      this._endEl.src = '';
    }

    // 原生 <audio> 元素，不依赖 AudioContext
    const el = new Audio(scene.end);
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    this._endEl = el;

    // 等待可播放
    await new Promise((resolve) => {
      el.addEventListener('canplaythrough', resolve, { once: true });
      el.addEventListener('error', resolve, { once: true });
      el.load();
    });
  }

  /* ─────────── 拨弦触发 ─────────── */

  triggerPurePluck() {
    this._ensureCtx();
    if (this._click) {
      this._click.volume(1.0);
      this._click.rate(1.0);
      this._click.play();
    }

    if (this._plucks.length > 0) {
      const idx = this._pluckIndex % this._plucks.length;
      this._pluckIndex++;
      const pluck = this._plucks[idx];
      if (pluck) {
        pluck.volume(1.0);
        pluck.rate(1.0);
        pluck.play();
      }
    }
  }

  /* ─────────── 结算音乐（原生 <audio>） ─────────── */

  playEndingMusic() {
    const el = this._endEl;
    if (!el) return;
    el.volume = 0;
    el.play().catch(() => {});
    // 渐入
    const start = performance.now();
    const tick = () => {
      const progress = Math.min((performance.now() - start) / 2000, 1);
      el.volume = progress * 0.8;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ─────────── 确保 AudioContext 处于活跃状态 ─────────── */

  _ensureCtx() {
    try {
      if (Howler.ctx && Howler.ctx.state === 'suspended') {
        Howler.ctx.resume();
      }
    } catch (e) {}
  }

  /* ─────────── 淡出结算音频（原生 <audio>） ─────────── */

  async fadeOutCurrentAudio(duration = 1500) {
    return new Promise((resolve) => {
      const el = this._endEl;
      if (!el || el.paused) { resolve(); return; }

      const startVol = el.volume;
      const start = performance.now();
      const tick = () => {
        const progress = Math.min((performance.now() - start) / duration, 1);
        el.volume = startVol * (1 - progress);
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          el.pause();
          el.src = '';
          this._endEl = null;
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /* ─────────── 内部工具 ─────────── */

  destroyAll() {
    [this._click, ...this._plucks].forEach((h) => {
      if (h) {
        try { h.stop(); } catch (_) {}
        try { h.unload(); } catch (_) {}
      }
    });
    if (this._endEl) {
      this._endEl.pause();
      this._endEl.src = '';
      this._endEl = null;
    }
    this._click = null;
    this._plucks = [];
    this._pluckIndex = 0;
    this._sharedLoaded = false;
  }

  _waitForLoad(howl) {
    return new Promise((resolve) => {
      if (howl.state() === 'loaded') { resolve(); return; }
      howl.once('load', resolve);
      howl.once('loaderror', (_id, err) => {
        console.warn('[AudioManager] load error:', err);
        resolve();
      });
    });
  }
}
