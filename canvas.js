/**
 * CanvasManager — 毛玻璃摄像头 + 水墨刮刮乐 + 阻尼震动渲染类
 *
 * 渲染管线（每帧从底到顶）：
 *   Layer 1  风景背景（cover 模式 + 暗角）
 *   Layer 2  毛玻璃摄像头（全不透明，水墨擦除区域挖洞露出风景）
 *   Layer 3  琥珀暗角蒙版
 *   Layer 4  震动琴弦（三层：主弦 + 高光 + 虚影拖尾）
 *   Layer 5  粒子（星尘 + 爆裂）
 *
 * ★ 关键架构：毛玻璃层在离屏画布上合成，用 destination-out 擦除掩码挖洞，
 *   再整层贴入主画布。挖洞处露出底层风景背景，实现"拨弦揭开新世界"效果。
 */
// 预分配段缓冲区（避免每帧 GC）
const _segBuf = new Array(25);

class CanvasManager {
  constructor() {
    this.canvas = document.getElementById('mainCanvas');
    this.ctx = this.canvas.getContext('2d');

    // ── 离屏画布 ──
    // 摄像头合成层（毛玻璃 + 清晰穿透在此画布内完成）
    this._camComposite = document.createElement('canvas');
    this._camCompositeCtx = this._camComposite.getContext('2d');

    // 水墨擦除掩码（半分辨率，白色 = 已擦除区域，持久化）
    this._maskCanvas = document.createElement('canvas');
    this._maskCtx = this._maskCanvas.getContext('2d');

    // 视频元素（由 app.js 设置）
    this._video = null;
    this._hasCamera = false;

    // 风景背景
    this._bgImage = null;
    this._bgLoaded = false;
    this._bgFallback = '#0a0a0a';

    // 风景 cover 缓存（避免每帧重算）
    this._sceneryCache = { dx: 0, dy: 0, dw: 0, dh: 0, cached: false };

    // ── 琴弦状态 — 双弦 ──
    this.strings = [
      {
        xRatio: 0.46,
        width: 3,
        frequency: 0.18,
        amplitudeScale: 0.85,
        amplitude: 0,
        phase: 0,
        hitY: 0.5,
        color: 'rgba(200, 168, 94, 0.85)',
      },
      {
        xRatio: 0.54,
        width: 5,
        frequency: 0.12,
        amplitudeScale: 1.15,
        amplitude: 0,
        phase: 0,
        hitY: 0.5,
        color: 'rgba(200, 168, 94, 0.75)',
      },
    ];

    // ── 粒子系统 ──
    this.dustParticles = [];
    this._dustSpawnAccum = 0;
    this.burstParticles = [];
    this.noteParticles = [];
    this._noteSpawnAccum = 0;

    // ── 水墨动画圈（视觉特效，不影响掩码） ──
    this.inkCircles = [];

    // ── 掩码是否有内容（持久标记，不受动画圈生命周期影响） ──
    this._maskHasContent = false;

    // ── 缓存的临时画布（避免每帧 GC） ──
    this._invMaskCanvas = null;   // 反转掩码（小尺寸）
    this._clearCamCanvas = null;  // 清晰摄像头（全尺寸）

    // ── 指尖追踪 ──
    this.fingerX = -1;
    this.fingerY = -1;
    this.hasFinger = false;

    // ── DPR ──
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    // ── 掩码是否已初始化 ──
    this._maskReady = false;

    // ── 噪点缓存 ──
    this._noiseCache = null;

    // ── 渐变缓存 ──
    this._amberGrad = null;
    this._sceneryGrad = null;

    // ── 羊皮卷缓存 ──
    this._parchmentCache = null;

    // ── 音符贴图缓存 ──
    this._noteSprite1 = this._createNoteSprite(0); // ♪
    this._noteSprite2 = this._createNoteSprite(1); // ♫

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  /* ═══════════════ 外部接口 ═══════════════ */

  setVideoElement(video) {
    this._video = video;
    this._hasCamera = true;
  }

  setBackground(src, fallbackColor) {
    this._bgLoaded = false;
    this._bgFallback = fallbackColor || '#0a0a0a';
    this._sceneryCache.cached = false;
    const img = new Image();
    return new Promise((resolve) => {
      img.onload = () => {
        this._bgImage = img;
        this._bgLoaded = true;
        this._sceneryCache.cached = false;
        resolve();
      };
      img.onerror = () => {
        this._bgImage = null;
        this._bgLoaded = false;
        resolve();
      };
      img.src = src;
    });
  }

  bounceString(index, hitY) {
    const s = this.strings[index];
    if (!s) return;

    const dpr = this._dpr;
    const logicalW = this.canvas.width / dpr;
    const baseAmplitude = logicalW * (0.08 + Math.random() * 0.02);
    s.amplitude = baseAmplitude * s.amplitudeScale;
    s.phase = 0;
    s.hitY = Math.max(0.05, Math.min(0.95, hitY));

    this._spawnBurst(s.xRatio * logicalW, hitY * (this.canvas.height / dpr));
  }

  setFingerPos(normX, normY) {
    this.fingerX = normX;
    this.fingerY = normY;
    this.hasFinger = true;
  }

  clearFinger() {
    this.hasFinger = false;
  }

  /* ═══════════════ 主渲染循环 ═══════════════ */

  render() {
    const dpr = this._dpr;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    const ctx = this.ctx;

    // ── Layer 1: 风景背景 ──
    this._drawScenery(ctx, W, H);

    // ── Layer 2: 摄像头复合层（在离屏画布内合成后整层贴入） ──
    this._drawCameraCompositeFinal(ctx, W, H);

    // ── Layer 3: 琥珀暗角蒙版 ──
    this._drawAmberVignette(ctx, W, H);

    // ── Layer 4: 震动琴弦 ──
    this._updateAndDrawStrings(ctx, W, H);

    // ── Layer 5: 粒子 ──
    this._updateAndDrawDust(ctx, W, H);
    this._updateAndDrawBurst(ctx);
    this._updateAndDrawNotes(ctx);
  }

  resetAll() {
    this.strings.forEach((s) => { s.amplitude = 0; s.phase = 0; });
    this.dustParticles = [];
    this.burstParticles = [];
    this.noteParticles = [];
    this.inkCircles = [];

    // 清空掩码
    this._maskHasContent = false;
    if (this._maskReady) {
      this._maskCtx.clearRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
    }
  }

  /* ═══════════════ Layer 1: 风景背景 ═══════════════ */

  _drawScenery(ctx, W, H) {
    ctx.save();
    if (this._bgLoaded && this._bgImage) {
      const img = this._bgImage;

      if (!this._sceneryCache.cached) {
        const imgRatio = img.width / img.height;
        const canvasRatio = W / H;
        let dw, dh, dx, dy;
        if (canvasRatio > imgRatio) {
          dw = W; dh = W / imgRatio; dx = 0; dy = (H - dh) / 2;
        } else {
          dh = H; dw = H * imgRatio; dx = (W - dw) / 2; dy = 0;
        }
        this._sceneryCache = { dx, dy, dw, dh, cached: true };
      }
      const { dx, dy, dw, dh } = this._sceneryCache;
      ctx.drawImage(img, dx, dy, dw, dh);

      // 风景暗角（缓存渐变）
      if (!this._sceneryGrad || this._sceneryGradW !== W || this._sceneryGradH !== H) {
        this._sceneryGrad = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.75);
        this._sceneryGrad.addColorStop(0, 'rgba(0,0,0,0)');
        this._sceneryGrad.addColorStop(1, 'rgba(0,0,0,0.5)');
        this._sceneryGradW = W;
        this._sceneryGradH = H;
      }
      ctx.fillStyle = this._sceneryGrad;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = this._bgFallback || '#0a0a0a';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  /* ═══════════════ Layer 2: 摄像头复合层 ═══════════════ */

  /**
   * 在 _camComposite 离屏画布内完成摄像头层合成，然后整层贴入主画布。
   *
   * 步骤：
   *   1. 合成层绘制毛玻璃摄像头（blur 25px + grayscale + 噪点）
   *   2. 临时画布绘制清晰摄像头 → 用反转掩码擦除未擦除区域 → 只剩清晰像素
   *   3. 将清晰像素 source-over 贴入合成层（穿透毛玻璃）
   *   4. 合成结果整层 source-over 贴入主画布（不破坏风景底层）
   *
   * ★ 所有 destination-out 操作仅发生在临时/离屏画布上，绝不伤及主画布风景层。
   */
  _drawCameraCompositeFinal(ctx, W, H) {
    if (!this._hasCamera || !this._video || this._video.readyState < 2) return;

    const dpr = this._dpr;
    const cCtx = this._camCompositeCtx;

    const needW = this.canvas.width;
    const needH = this.canvas.height;
    if (this._camComposite.width !== needW || this._camComposite.height !== needH) {
      this._camComposite.width = needW;
      this._camComposite.height = needH;
      cCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Step 1: 在离屏画布绘制毛玻璃摄像头（全不透明） ──
    cCtx.clearRect(0, 0, W, H);
    cCtx.save();
    cCtx.filter = 'blur(25px) grayscale(40%) sepia(25%)';
    this._drawMirroredVideo(cCtx, this._video, W, H);
    cCtx.restore();
    this._drawFrostNoise(cCtx, W, H);

    // ── Step 1.5: 羊皮卷复古遮罩 ──
    this._drawParchmentOverlay(cCtx, W, H);

    // ── Step 2: 用擦除掩码在合成层上挖洞（destination-out） ──
    if (this._maskHasContent && this._maskReady) {
      this._ensureMaskSize();
      cCtx.save();
      cCtx.globalCompositeOperation = 'destination-out';
      // 掩码是半分辨率，需要缩放绘制到全尺寸合成层
      cCtx.drawImage(this._maskCanvas, 0, 0, W, H);
      cCtx.restore();
    }

    // ── Step 3: 将带洞的毛玻璃层贴入主画布（洞的位置露出风景背景） ──
    ctx.drawImage(this._camComposite, 0, 0, W, H);
  }

  /* ═══════════════ Layer 3: 琥珀暗角蒙版 ═══════════════ */

  _drawAmberVignette(ctx, W, H) {
    if (!this._amberGrad || this._amberGradW !== W || this._amberGradH !== H) {
      this._amberGrad = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.75);
      this._amberGrad.addColorStop(0, 'rgba(0,0,0,0)');
      this._amberGrad.addColorStop(0.5, 'rgba(15, 10, 5, 0.1)');
      this._amberGrad.addColorStop(1, 'rgba(15, 10, 5, 0.45)');
      this._amberGradW = W;
      this._amberGradH = H;
    }
    ctx.save();
    ctx.fillStyle = this._amberGrad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ═══════════════ 工具：镜像绘制视频 ═══════════════ */

  _drawMirroredVideo(ctx, video, W, H) {
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (vw === 0 || vh === 0) return;
    const vRatio = vw / vh;
    const cRatio = W / H;
    let dw, dh, dx, dy;
    if (cRatio > vRatio) {
      dw = W; dh = W / vRatio; dx = 0; dy = (H - dh) / 2;
    } else {
      dh = H; dw = H * vRatio; dx = (W - dw) / 2; dy = 0;
    }

    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, W - dx - dw, dy, dw, dh);
    ctx.restore();
  }

  /* ═══════════════ 噪点纹理 ═══════════════ */

  _drawFrostNoise(ctx, W, H) {
    if (!this._noiseCache || this._noiseCache.w !== W || this._noiseCache.h !== H) {
      this._regenerateNoiseCache(W, H);
    }
    ctx.save();
    ctx.drawImage(this._noiseCache.canvas, 0, 0);
    ctx.restore();
  }

  _regenerateNoiseCache(W, H) {
    if (!this._noiseCache) {
      this._noiseCache = { canvas: document.createElement('canvas') };
    }
    const c = this._noiseCache.canvas;
    c.width = W;
    c.height = H;
    const nCtx = c.getContext('2d');
    nCtx.fillStyle = 'rgba(20, 18, 15, 0.08)';
    const step = 6;
    const seed = (performance.now() * 0.01) | 0;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const v = ((x * 7 + y * 13 + seed) * 2654435761) >>> 0;
        if ((v & 0xFF) < 80) {
          nCtx.globalAlpha = (v & 0x0F) / 80;
          nCtx.fillRect(x, y, 2, 2);
        }
      }
    }
    nCtx.globalAlpha = 1;
    this._noiseCache.w = W;
    this._noiseCache.h = H;
  }

  /* ═══════════════ 羊皮卷复古遮罩（缓存模式） ═══════════════ */

  /**
   * 在合成层上叠加羊皮卷质感遮罩
   * 所有纹理层预渲染到离屏 canvas，每帧只需一次 drawImage
   */
  _drawParchmentOverlay(ctx, W, H) {
    if (!this._parchmentCache || this._parchmentCache.w !== W || this._parchmentCache.h !== H) {
      this._regenerateParchmentCache(W, H);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this._parchmentCache.canvas, 0, 0);
    ctx.restore();
  }

  _regenerateParchmentCache(W, H) {
    if (!this._parchmentCache) {
      this._parchmentCache = { canvas: document.createElement('canvas') };
    }
    const c = this._parchmentCache.canvas;
    c.width = W;
    c.height = H;
    const pCtx = c.getContext('2d');

    // Layer 1: 暖色底（径向渐变）
    const baseGrad = pCtx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.7);
    baseGrad.addColorStop(0, 'rgba(210, 180, 130, 1)');
    baseGrad.addColorStop(0.5, 'rgba(180, 150, 100, 1)');
    baseGrad.addColorStop(1, 'rgba(120, 90, 55, 1)');
    pCtx.fillStyle = baseGrad;
    pCtx.fillRect(0, 0, W, H);

    // Layer 2: 深沉暗角
    const vignetteGrad = pCtx.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.75);
    vignetteGrad.addColorStop(0, 'rgba(255, 245, 225, 1)');
    vignetteGrad.addColorStop(0.4, 'rgba(220, 195, 155, 1)');
    vignetteGrad.addColorStop(0.7, 'rgba(160, 125, 80, 1)');
    vignetteGrad.addColorStop(1, 'rgba(80, 55, 30, 1)');
    pCtx.globalCompositeOperation = 'multiply';
    pCtx.fillStyle = vignetteGrad;
    pCtx.fillRect(0, 0, W, H);

    // Layer 3: 粗糙纹理（一次性生成）
    pCtx.globalCompositeOperation = 'overlay';
    pCtx.globalAlpha = 0.12;
    const step = 4;
    const seed = 42;
    pCtx.fillStyle = '#8B7355';
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const v = ((x * 13 + y * 7 + seed) * 2654435761) >>> 0;
        if ((v & 0xFF) < 60) {
          pCtx.globalAlpha = ((v >> 8) & 0x0F) / 60 * 0.12;
          pCtx.fillRect(x, y, 3, 3);
        }
      }
    }

    // Layer 4: 细微划痕
    pCtx.globalCompositeOperation = 'soft-light';
    pCtx.globalAlpha = 0.06;
    pCtx.strokeStyle = 'rgba(180, 155, 110, 0.5)';
    pCtx.lineWidth = 0.8;
    pCtx.lineCap = 'round';
    for (let i = 0; i < 20; i++) {
      const v = ((i * 2654435761 + 77) >>> 0);
      const x1 = (v % W);
      const y1 = ((v >> 10) % H);
      const len = 30 + (v % 80);
      const angle = ((v >> 5) % 314) / 100;
      pCtx.beginPath();
      pCtx.moveTo(x1, y1);
      pCtx.lineTo(x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len);
      pCtx.stroke();
    }

    pCtx.globalAlpha = 1;
    this._parchmentCache.w = W;
    this._parchmentCache.h = H;
  }

  /* ═══════════════ Layer 4: 琴弦震动 ═══════════════ */

  _updateAndDrawStrings(ctx, W, H) {
    const decay = 0.96;

    this.strings.forEach((s) => {
      const x = Math.round(s.xRatio * W);

      if (s.amplitude > 0.1) {
        s.phase += s.frequency;
        const displacement = Math.sin(s.phase) * s.amplitude;
        s.amplitude *= decay;
        this._drawVibratingString(ctx, s, x, H, displacement);
      } else {
        s.amplitude = 0;
        this._drawStaticString(ctx, s, x, H);
      }
    });
  }

  _drawStaticString(ctx, s, x, H) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    // 静态弦用轻量发光代替昂贵的 shadowBlur
    ctx.shadowColor = 'rgba(200, 168, 94, 0.3)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.restore();
  }

  _drawVibratingString(ctx, s, x, H, displacement) {
    const segments = 24;
    const hitPixelY = s.hitY * H;
    const phase = s.phase;

    // 复用预分配缓冲区，避免每帧创建新对象
    const segs = _segBuf;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const y = t * H;
      const dist = Math.abs(y - hitPixelY) / H;
      let seg = segs[i];
      if (!seg) {
        seg = { y: 0, env8: 0, env12: 0, dx: 0 };
        segs[i] = seg;
      }
      seg.y = y;
      seg.env8 = Math.exp(-dist * dist * 8);
      seg.env12 = Math.exp(-dist * dist * 12);
    }

    // Layer A: 粗虚影拖尾
    ctx.save();
    ctx.strokeStyle = 'rgba(200, 168, 94, 0.12)';
    ctx.lineWidth = s.width + 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(200, 168, 94, 0.25)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const s0 = segs[i];
      const wobble =
        Math.sin(phase * 1.5 + t * 5) * 0.5 +
        Math.sin(phase * 2.8 + t * 10) * 0.3 +
        Math.sin(phase * 0.7 + t * 2) * 0.2;
      ctx.lineTo(x + displacement * 1.3 * s0.env8 * wobble, s0.y);
    }
    ctx.stroke();
    ctx.restore();

    // Layer B & C 共享 wobble 公式
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(200, 168, 94, 0.5)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const s0 = segs[i];
      const wobble =
        Math.sin(phase * 2.1 + t * 8) * 0.3 +
        Math.sin(phase * 3.7 + t * 14) * 0.15 +
        Math.sin(phase * 1.0 + t * 3) * 0.55;
      const dx = displacement * s0.env12 * wobble;
      s0.dx = dx; // 缓存给 Layer C
      ctx.lineTo(x + dx, s0.y);
    }
    ctx.stroke();
    ctx.restore();

    // Layer C: 高光线（复用 Layer B 的 dx）
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 220, 130, 0.3)';
    ctx.lineWidth = Math.max(1, s.width - 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(255, 220, 130, 0.2)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let i = 1; i <= segments; i++) {
      const s0 = segs[i];
      ctx.lineTo(x + s0.dx, s0.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ═══════════════ Layer 5: 星尘粒子 ═══════════════ */

  _updateAndDrawDust(ctx, W, H) {
    if (this.hasFinger && this.fingerX > 0 && this.fingerY > 0) {
      this._dustSpawnAccum++;
      if (this._dustSpawnAccum >= 2) {
        this._dustSpawnAccum = 0;
        this._spawnDust(this.fingerX * W, this.fingerY * H);
      }
      this._noteSpawnAccum++;
      if (this._noteSpawnAccum >= 12) {
        this._noteSpawnAccum = 0;
        this._spawnNoteParticles(this.fingerX * W, this.fingerY * H);
      }
    }

    const particles = this.dustParticles;
    ctx.save();
    ctx.shadowBlur = 3;
    let len = particles.length;
    for (let i = len - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= p.decay;
      if (p.life <= 0) {
        particles[i] = particles[--len];
        continue;
      }

      p.x += p.vx;
      p.y += p.vy;
      p.vy -= 0.02;
      p.vx *= 0.98;

      const life = p.life;
      const size = p.size * (0.5 + life * 0.5);

      // globalAlpha 控制 fill 透明度；shadowColor 需独立设置 alpha
      ctx.globalAlpha = life * 0.6;
      ctx.fillStyle = p._fill;
      ctx.shadowColor = `rgba(${p.r},${p.g},${p.b},${life * 0.3})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    particles.length = len;
    ctx.restore();
  }

  _spawnDust(x, y) {
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const r = 180 + Math.floor(Math.random() * 40);
      const g = 140 + Math.floor(Math.random() * 50);
      const b = 50 + Math.floor(Math.random() * 40);
      this.dustParticles.push({
        x: x + (Math.random() - 0.5) * 20,
        y: y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 1.2,
        vy: (Math.random() - 0.5) * 1.2,
        size: 1.5 + Math.random() * 2.5,
        life: 1.0,
        decay: 0.008 + Math.random() * 0.008,
        r, g, b,
        // 预缓存颜色字符串，避免每帧模板拼接
        _fill: `rgb(${r},${g},${b})`,
      });
    }
  }

  /* ═══════════════ 爆裂粒子 ═══════════════ */

  _spawnBurst(x, y) {
    for (let i = 0; i < 15; i++) {
      const angle = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * 0.8;
      const speed = 3 + Math.random() * 6;
      const r = 200 + Math.floor(Math.random() * 55);
      const g = 160 + Math.floor(Math.random() * 50);
      const b = 40 + Math.floor(Math.random() * 40);
      this.burstParticles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 2 + Math.random() * 4,
        life: 1.0,
        decay: 1.0 / (0.8 * 60),
        gravity: 0.12,
        r, g, b,
        _fill: `rgb(${r},${g},${b})`,
      });
    }
  }

  _updateAndDrawBurst(ctx) {
    const particles = this.burstParticles;
    ctx.save();
    ctx.shadowBlur = 5;
    let len = particles.length;
    for (let i = len - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= p.decay;
      if (p.life <= 0) {
        particles[i] = particles[--len];
        continue;
      }

      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.98;

      const alpha = Math.max(0, p.life);
      const size = p.size * (0.3 + alpha * 0.7);

      // globalAlpha 控制 fill；shadowColor 需独立 alpha
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p._fill;
      ctx.shadowColor = `rgba(${p.r},${p.g},${p.b},${alpha * 0.6})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    particles.length = len;
    ctx.restore();
  }

  /* ═══════════════ 音符粒子 ═══════════════ */

  /**
   * 预渲染音符到离屏 canvas（含发光，只需生成一次）
   * @param {number} type 0=♪ 1=♫
   */
  _createNoteSprite(type) {
    const size = 48; // 足够大的贴图尺寸
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const nCtx = canvas.getContext('2d');
    const s = size / 24;

    nCtx.fillStyle = 'rgb(230, 195, 80)';
    nCtx.shadowColor = 'rgba(230, 195, 80, 0.7)';
    nCtx.shadowBlur = 8;
    nCtx.strokeStyle = 'rgb(230, 195, 80)';
    nCtx.lineWidth = 1.5 * s;
    nCtx.lineCap = 'round';

    if (type === 0) {
      // ♪ 八分音符
      nCtx.beginPath();
      nCtx.ellipse(size / 2 - 1 * s, size / 2 + 5 * s, 4 * s, 3 * s, -0.3, 0, Math.PI * 2);
      nCtx.fill();
      nCtx.beginPath();
      nCtx.moveTo(size / 2 + 3 * s, size / 2 + 4 * s);
      nCtx.lineTo(size / 2 + 3 * s, size / 2 - 6 * s);
      nCtx.stroke();
      nCtx.lineWidth = 2 * s;
      nCtx.beginPath();
      nCtx.moveTo(size / 2 + 3 * s, size / 2 - 6 * s);
      nCtx.quadraticCurveTo(size / 2 + 7 * s, size / 2 - 4 * s, size / 2 + 5 * s, size / 2 - 1 * s);
      nCtx.stroke();
    } else {
      // ♫ 双音符
      nCtx.beginPath();
      nCtx.ellipse(size / 2 - 4 * s, size / 2 + 5 * s, 3.5 * s, 2.5 * s, -0.3, 0, Math.PI * 2);
      nCtx.fill();
      nCtx.beginPath();
      nCtx.ellipse(size / 2 + 3 * s, size / 2 + 5 * s, 3.5 * s, 2.5 * s, -0.3, 0, Math.PI * 2);
      nCtx.fill();
      nCtx.beginPath();
      nCtx.moveTo(size / 2 - 0.5 * s, size / 2 + 4 * s);
      nCtx.lineTo(size / 2 - 0.5 * s, size / 2 - 6 * s);
      nCtx.stroke();
      nCtx.beginPath();
      nCtx.moveTo(size / 2 + 6.5 * s, size / 2 + 4 * s);
      nCtx.lineTo(size / 2 + 6.5 * s, size / 2 - 6 * s);
      nCtx.stroke();
      nCtx.lineWidth = 2.5 * s;
      nCtx.beginPath();
      nCtx.moveTo(size / 2 - 0.5 * s, size / 2 - 6 * s);
      nCtx.lineTo(size / 2 + 6.5 * s, size / 2 - 6 * s);
      nCtx.stroke();
    }

    return canvas;
  }

  _spawnNoteParticles(x, y) {
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.6;
      const speed = 1.2 + Math.random() * 2;
      this.noteParticles.push({
        x: x + (Math.random() - 0.5) * 30,
        y: y + (Math.random() - 0.5) * 15,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.8,
        size: 8 + Math.random() * 8,
        rotation: (Math.random() - 0.5) * 0.6,
        rotSpeed: (Math.random() - 0.5) * 0.03,
        life: 1.0,
        decay: 0.006 + Math.random() * 0.006,
        // 音符类型：0=八分音符♪ 1=双音符♫
        type: Math.random() > 0.5 ? 0 : 1,
        // 金色调
        r: 200 + Math.floor(Math.random() * 55),
        g: 170 + Math.floor(Math.random() * 50),
        b: 60 + Math.floor(Math.random() * 40),
      });
    }
  }

  _updateAndDrawNotes(ctx) {
    const particles = this.noteParticles;
    let len = particles.length;
    for (let i = len - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= p.decay;
      if (p.life <= 0) {
        particles[i] = particles[--len];
        continue;
      }

      p.vy -= 0.015;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.99;
      p.rotation += p.rotSpeed;

      const alpha = p.life * 0.85;
      // 跳过几乎不可见的粒子，减少无意义的 canvas 操作
      if (alpha < 0.03) continue;

      const drawSize = p.size * (0.6 + p.life * 0.4);
      const sprite = p.type === 0 ? this._noteSprite1 : this._noteSprite2;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.restore();
    }
    particles.length = len;
  }

  /* ═══════════════ 水墨掩码管理 ═══════════════ */

  _ensureMaskSize() {
    const dpr = this._dpr;
    const mW = Math.ceil(this.canvas.width / dpr / 2);
    const mH = Math.ceil(this.canvas.height / dpr / 2);

    if (!this._maskReady) {
      // 首次初始化
      this._maskCanvas.width = mW;
      this._maskCanvas.height = mH;
      this._maskReady = true;
      return;
    }

    if (this._maskCanvas.width !== mW || this._maskCanvas.height !== mH) {
      // 尺寸变化时保留旧数据
      const oldW = this._maskCanvas.width;
      const oldH = this._maskCanvas.height;
      let oldData = null;
      if (oldW > 0 && oldH > 0) {
        try { oldData = this._maskCtx.getImageData(0, 0, oldW, oldH); } catch (_) {}
      }
      this._maskCanvas.width = mW;
      this._maskCanvas.height = mH;
      if (oldData) {
        this._maskCtx.putImageData(oldData, 0, 0);
      }
    }
  }

  /**
   * 在水墨掩码上添加擦除圆圈（逻辑像素坐标）
   */
  drawInkToMask(logicalX, logicalY) {
    this._ensureMaskSize();
    this._maskHasContent = true;
    const mW = this._maskCanvas.width;
    const mH = this._maskCanvas.height;
    const dpr = this._dpr;
    const logicalW = this.canvas.width / dpr;
    const logicalH = this.canvas.height / dpr;

    const cx = (logicalX / logicalW) * mW;
    const cy = (logicalY / logicalH) * mH;
    const baseR = (70 / Math.max(logicalW, logicalH)) * Math.max(mW, mH);

    const mCtx = this._maskCtx;
    mCtx.save();
    mCtx.globalCompositeOperation = 'source-over';

    // 主墨团 — 较大的不规则团块
    const mainCount = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < mainCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * baseR * 0.35;
      const r = baseR * (0.6 + Math.random() * 0.5);
      const ox = cx + Math.cos(angle) * dist;
      const oy = cy + Math.sin(angle) * dist;
      const grad = mCtx.createRadialGradient(ox, oy, 0, ox, oy, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.5)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      mCtx.fillStyle = grad;
      mCtx.beginPath();
      mCtx.arc(ox, oy, r, 0, Math.PI * 2);
      mCtx.fill();
    }

    // 飞溅墨点 — 小而散的卫星点
    const splatCount = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < splatCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = baseR * (0.3 + Math.random() * 0.9);
      const r = baseR * (0.08 + Math.random() * 0.18);
      const ox = cx + Math.cos(angle) * dist;
      const oy = cy + Math.sin(angle) * dist;
      mCtx.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.4})`;
      mCtx.beginPath();
      mCtx.arc(ox, oy, r, 0, Math.PI * 2);
      mCtx.fill();
    }

    // 中心浓墨 — 确保核心区域完全擦除
    const coreR = baseR * 0.35;
    const coreGrad = mCtx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreGrad.addColorStop(0, 'rgba(255,255,255,1)');
    coreGrad.addColorStop(1, 'rgba(255,255,255,0.7)');
    mCtx.fillStyle = coreGrad;
    mCtx.beginPath();
    mCtx.arc(cx, cy, coreR, 0, Math.PI * 2);
    mCtx.fill();

    mCtx.restore();
  }

  /**
   * 添加动画水墨擦除圈（视觉效果用）
   */
  addInkCircle(x, y) {
    this.inkCircles.push({
      x, y,
      radius: 10,
      speed: 2 + Math.random() * 2,
      opacity: 0.15 + Math.random() * 0.1,
    });
  }

  /**
   * 水墨润开全图展开动画 — 从中心向四周擦除全部毛玻璃
   * @returns {Promise} 动画完成后 resolve
   */
  revealAll() {
    return new Promise((resolve) => {
      this._ensureMaskSize();
      this._maskHasContent = true;
      const mW = this._maskCanvas.width;
      const mH = this._maskCanvas.height;
      const mCtx = this._maskCtx;
      const cx = mW / 2;
      const cy = mH / 2;
      const maxR = Math.sqrt(cx * cx + cy * cy) * 1.2;
      const duration = 2200;
      const start = performance.now();

      // 预生成不规则种子（每帧保持一致的随机分布）
      const seeds = [];
      for (let i = 0; i < 8; i++) {
        seeds.push({
          angle: (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.5,
          distFactor: 0.05 + Math.random() * 0.12,
          sizeFactor: 0.7 + Math.random() * 0.45,
          phaseOffset: Math.random() * Math.PI * 2,
        });
      }
      const splatSeeds = [];
      for (let i = 0; i < 12; i++) {
        splatSeeds.push({
          angle: Math.random() * Math.PI * 2,
          distFactor: 0.4 + Math.random() * 0.8,
          sizeFactor: 0.06 + Math.random() * 0.15,
          alphaFactor: 0.2 + Math.random() * 0.5,
        });
      }

      const tick = (now) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out-cubic 先快后慢
        const eased = 1 - Math.pow(1 - progress, 3);
        const r = maxR * eased;

        mCtx.save();
        mCtx.globalCompositeOperation = 'source-over';

        // 主墨团 — 8 个不规则团块随半径扩大
        for (const s of seeds) {
          const wobble = 1 + 0.2 * Math.sin(progress * 6 + s.phaseOffset);
          const cr = r * s.sizeFactor * wobble;
          const ox = cx + Math.cos(s.angle + progress * 1.5) * r * s.distFactor;
          const oy = cy + Math.sin(s.angle + progress * 1.5) * r * s.distFactor;
          const grad = mCtx.createRadialGradient(ox, oy, cr * 0.2, ox, oy, cr);
          grad.addColorStop(0, 'rgba(255,255,255,0.85)');
          grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          mCtx.fillStyle = grad;
          mCtx.beginPath();
          mCtx.arc(ox, oy, cr, 0, Math.PI * 2);
          mCtx.fill();
        }

        // 飞溅墨点 — 小而散，提前出现
        if (progress > 0.15) {
          const splatProg = Math.min((progress - 0.15) / 0.6, 1);
          for (const s of splatSeeds) {
            const sr = r * s.sizeFactor * splatProg;
            const sx = cx + Math.cos(s.angle) * r * s.distFactor;
            const sy = cy + Math.sin(s.angle) * r * s.distFactor;
            mCtx.fillStyle = `rgba(255,255,255,${s.alphaFactor * splatProg})`;
            mCtx.beginPath();
            mCtx.arc(sx, sy, sr, 0, Math.PI * 2);
            mCtx.fill();
          }
        }

        // 中心浓墨
        const coreR = r * 0.35;
        const coreGrad = mCtx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
        coreGrad.addColorStop(0, 'rgba(255,255,255,0.95)');
        coreGrad.addColorStop(1, 'rgba(255,255,255,0.3)');
        mCtx.fillStyle = coreGrad;
        mCtx.beginPath();
        mCtx.arc(cx, cy, coreR, 0, Math.PI * 2);
        mCtx.fill();

        mCtx.restore();

        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          // 确保完全擦除
          mCtx.save();
          mCtx.globalCompositeOperation = 'source-over';
          mCtx.fillStyle = '#fff';
          mCtx.fillRect(0, 0, mW, mH);
          mCtx.restore();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /* ═══════════════ Resize ═══════════════ */

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 摄像头合成层
    this._camComposite.width = w * dpr;
    this._camComposite.height = h * dpr;
    this._camCompositeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 掩码（半分辨率）
    this._maskCanvas.width = Math.ceil(w / 2);
    this._maskCanvas.height = Math.ceil(h / 2);
    this._maskReady = true;

    // 重算风景 cover 缓存
    this._sceneryCache.cached = false;

    // 噪点缓存失效
    if (this._noiseCache) this._noiseCache.w = 0;

    // 渐变缓存失效
    this._amberGrad = null;
    this._sceneryGrad = null;

    // 羊皮卷缓存失效
    if (this._parchmentCache) this._parchmentCache.w = 0;
  }
}
