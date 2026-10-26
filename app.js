/**
 * SCENE_POOL — 静态资源数据字典
 *
 * click / pluck 全局共用一套，只有 end（结算音乐）按场景区分
 */
const SHARED_AUDIO = {
  click: "audio/click.mp3",
  pluck: ["audio/pluck_1.mp3", "audio/pluck_2.mp3", "audio/pluck_3.mp3"],
};

const SCENE_POOL = [
  { id: 1, title: "桑图尔 · 波斯遗韵", bg: "images/1_santur.jpg", bgColor: "#1a1208", end: "audio/e_santur.mp3", video: "video/santur.mp4" },
  { id: 2, title: "西塔尔 · 恒河之诗", bg: "images/2_sitar.jpg", bgColor: "#0a1a0a", end: "audio/e_sitar.mp3", video: "video/sitar.mp4" },
  { id: 3, title: "乌德琴 · 沙漠月光", bg: "images/3_oud.jpg", bgColor: "#1a0a0a", end: "audio/e_oud.mp3", video: "video/oud.mp4" },
  { id: 4, title: "奈伊笛 · 苏菲低语", bg: "images/4_ney.jpg", bgColor: "#0a0a1e", end: "audio/e_ney.mp3", video: "video/ney.mp4" },
  { id: 5, title: "科拉琴 · 非洲韵律", bg: "images/5_kola.jpg", bgColor: "#1a1a0a", end: "audio/e_kola.mp3", video: "video/kola.mp4" },
  { id: 6, title: "鲁巴布 · 喀布尔之歌", bg: "images/6_rubab.jpg", bgColor: "#1a1008", end: "audio/e_rubab.mp3", video: "video/rubab.mp4" },
];

/**
 * AppCore — 过渡状态机与手势碰撞控制类
 *
 * 状态机：idle → loading → playing → settling → video → settling → idle
 *
 * 核心职责：
 * - 初始化全黑 → 毛玻璃摄像头渐显
 * - MediaPipe Hands 食指尖追踪（Landmark 8，镜像翻转）
 * - 穿越琴弦碰撞检测 + 水墨擦除
 * - 电影级黑场音画渐隐过渡（1.5s）
 * - 通关结算与全屏重启
 * - 点击播放场景视频
 */
class AppCore {
  constructor() {
    this.audioManager = new AudioManager();
    this.canvasManager = new CanvasManager();

    this._fadeOverlay = document.getElementById('fadeOverlay');
    this._startMask = document.getElementById('startMask');
    this._sceneTitle = document.getElementById('sceneTitle');
    this._sceneTitleText = document.getElementById('sceneTitleText');
    this._waveHint = document.getElementById('waveHint');
    this._webcam = document.getElementById('webcam');
    this._bgmAudio = document.getElementById('bgmAudio');
    this._videoEl = document.getElementById('sceneVideo');

    // 状态机
    this.state = 'idle';
    this._currentScene = null;
    this._usedSceneIds = new Set();

    // MediaPipe
    this._hands = null;
    this._mpCamera = null;
    this._lastFingerX = -1;
    this._lastFingerY = -1;
    this._hasHandTracking = false;

    // 鼠标/触屏兜底
    this._lastMouseX = -1;
    this._lastMouseY = -1;

    // 结算标记
    this.isSettled = false;

    // 拨弦冷却（每弦独立）
    this._pluckCooldown = [0, 0];

    // 拨弦计数（结算触发用）
    this._pluckCount = 0;
    this._pluckThreshold = 12 + Math.floor(Math.random() * 8); // 12~19 次触发结算

    // 视频预加载标记
    this._videoPreloaded = false;
    this._preloadedVideoSrc = null;

    // 当前场景视频是否已观看（防止通关后重复播放视频）
    this._videoWatched = false;

    // 动画帧
    this._rafId = null;
  }

  /* ═══════════════ 初始化 ═══════════════ */

  async init() {
    this._bindPointerFallback();
    this._tick = this._tick.bind(this);
    this._tick();

    // 预加载共享音频（click/pluck）
    this.audioManager.initSharedAudio(SHARED_AUDIO).catch(() => {});

    // 立即播放 BGM（原生 <audio> 元素）
    this._playBGM();

    // 解锁 AudioContext（拨弦/结算音乐走 Web Audio 需要）
    this._unlockAudioContext();

    // 点击遮罩 → 直接开始游戏
    this._startMask.addEventListener('pointerdown', () => this._onTapStart(), { once: true });
  }

  /** 原生 <audio> 播放 BGM */
  _playBGM() {
    const audio = this._bgmAudio;
    if (!audio) return;
    audio.volume = 0.5;
    audio.play().catch(() => {
      // 自动播放被拦截，首次交互时重试
      const retry = () => { audio.play().catch(() => {}); };
      document.addEventListener('pointerdown', retry, { once: true });
      document.addEventListener('keydown', retry, { once: true });
    });
  }

  /** 解锁 Howler AudioContext（拨弦/结算音乐需要） */
  _unlockAudioContext() {
    try {
      Howler.volume(1);
      const ctx = Howler.ctx;
      if (ctx && ctx.state === 'suspended') {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        ctx.resume();
      }
    } catch (e) {}
  }

  /** 原生 <audio> 淡出 */
  _fadeOutBGM(duration) {
    const audio = this._bgmAudio;
    if (!audio || audio.paused) return;
    const startVol = audio.volume;
    const startTime = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      audio.volume = startVol * (1 - progress);
      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        audio.pause();
      }
    };
    requestAnimationFrame(tick);
  }

  /**
   * 点击遮罩后：平滑过渡到游戏
   *
   * 1. 恢复 AudioContext，确保 BGM 继续播放
   * 2. 遮罩淡出 + 场景加载 + 摄像头权限 三者并行
   * 3. 全部就绪后，渲染一帧确保背景就位
   * 4. 黑场渐出露出游戏画面，BGM 随后淡出
   */
  async _onTapStart() {
    // 确保 AudioContext 恢复（拨弦/结算音乐依赖 Web Audio）
    try { await Howler.ctx.resume(); } catch (e) {}
    this._unlockAudioContext();

    // 确保共享音频已加载
    await this.audioManager.initSharedAudio(SHARED_AUDIO).catch(() => {});

    // 确保 BGM 在播放（原生 <audio>）
    this._playBGM();

    this.state = 'loading';

    // 随机选场景，开始加载资源
    this.canvasManager.resetAll();
    this._pluckCount = 0;
    this._pluckThreshold = 12 + Math.floor(Math.random() * 8);
    const scene = this._pickRandomScene();
    this._currentScene = scene;

    // ── 三者并行：遮罩淡出 + 场景加载 + 摄像头权限 ──
    this._startMask.style.transition = 'opacity 1.5s ease';
    this._startMask.style.opacity = '0';

    const maskDone = new Promise(r => setTimeout(r, 1600));
    const sceneDone = Promise.all([
      this.canvasManager.setBackground(scene.bg, scene.bgColor),
      this.audioManager.loadSceneAudio(scene),
    ]);
    const cameraDone = this._initMediaPipe();

    // 等待三者全部完成
    await Promise.all([maskDone, sceneDone, cameraDone]);

    // 隐藏遮罩
    this._startMask.style.display = 'none';

    // ── 关键：先渲染一帧，确保背景图片已在画布上 ──
    this._fadeOverlay.style.opacity = '1';
    this._fadeOverlay.classList.add('active');
    this.canvasManager.render();

    // ── 黑场渐出：平滑露出游戏画面（2 秒） ──
    await this._animateOverlay(1, 0, 2000);
    this._fadeOverlay.classList.remove('active');

    this.state = 'playing';

    // 游戏完全可见后，BGM 缓缓淡出
    this._fadeOutBGM(2000);
  }

  /* ═══════════════ MediaPipe Hands ═══════════════ */

  async _initMediaPipe() {
    try {
      if (typeof Hands === 'undefined') {
        console.warn('[AppCore] MediaPipe Hands not loaded, using pointer fallback');
        return;
      }

      this._hands = new Hands({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
      });

      this._hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });

      this._hands.onResults((results) => this._onHandResults(results));

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 480 },
      });
      this._webcam.srcObject = stream;
      await this._webcam.play();

      // 将视频元素传递给 CanvasManager
      this.canvasManager.setVideoElement(this._webcam);

      this._mpCamera = new Camera(this._webcam, {
        onFrame: async () => {
          if (this._hands) {
            await this._hands.send({ image: this._webcam });
          }
        },
        width: 640,
        height: 480,
      });
      this._mpCamera.start();
      this._hasHandTracking = true;
    } catch (err) {
      console.warn('[AppCore] MediaPipe init failed:', err);
    }
  }

  _onHandResults(results) {
    if (this.state !== 'playing') return;

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      this.canvasManager.clearFinger();
      return;
    }

    const lm = results.multiHandLandmarks[0];
    const tip = lm[8]; // 食指尖
    const normX = 1 - tip.x; // 镜像翻转
    const normY = tip.y;

    this.canvasManager.setFingerPos(normX, normY);

    if (this.state === 'playing') {
      this._checkStringCollision(normX, normY);
    }

    this._lastFingerX = normX;
    this._lastFingerY = normY;
  }

  /* ═══════════════ 场景视频播放 ═══════════════ */

  /**
   * 预加载场景视频（在场景加载时调用，提前缓存视频元数据）
   */
  _preloadSceneVideo(scene) {
    if (!scene || !scene.video || !this._videoEl) return;
    // 如果已经是同一个视频，跳过
    if (this._preloadedVideoSrc === scene.video) return;

    // 使用一个隐藏的临时视频元素来预加载，避免影响显示的 video 元素
    if (!this._preloadVideoEl) {
      this._preloadVideoEl = document.createElement('video');
      this._preloadVideoEl.preload = 'auto';
      this._preloadVideoEl.muted = true;
      this._preloadVideoEl.playsInline = true;
      this._preloadVideoEl.style.display = 'none';
      document.body.appendChild(this._preloadVideoEl);
    }
    this._preloadVideoEl.src = scene.video;
    this._preloadVideoEl.load();
    this._videoPreloaded = false;
    this._preloadedVideoSrc = scene.video;

    // 监听预加载完成
    const onReady = () => {
      this._videoPreloaded = true;
      this._preloadVideoEl.removeEventListener('canplaythrough', onReady);
      this._preloadVideoEl.removeEventListener('loadedmetadata', onReady);
    };
    this._preloadVideoEl.addEventListener('canplaythrough', onReady, { once: true });
    this._preloadVideoEl.addEventListener('loadedmetadata', onReady, { once: true });
  }

  async _playSceneVideo() {
    this.state = 'video';
    this.isSettled = false;

    const scene = this._currentScene;
    if (!scene || !scene.video || !this._videoEl) {
      this._onVideoEnd();
      return;
    }

    // 隐藏提示文字
    const subtitle = this._sceneTitle.querySelector('p');
    if (subtitle) subtitle.style.display = 'none';
    if (this._waveHint) {
      this._waveHint.style.opacity = '0';
      this._waveHint.style.display = 'none';
    }
    this._sceneTitle.style.opacity = '0';

    // 淡出结算音乐
    this.audioManager.fadeOutCurrentAudio(2000);

    // 创建渐变边框遮罩
    const borderOverlay = document.createElement('div');
    borderOverlay.id = 'videoBorderOverlay';
    Object.assign(borderOverlay.style, {
      position: 'fixed', top: '0', left: '0',
      width: '100%', height: '100%',
      zIndex: '160', pointerEvents: 'none',
      opacity: '0', transition: 'opacity 1.5s ease',
      background:
        'linear-gradient(to right, rgba(140, 100, 30, 0.7) 0%, transparent 15%, transparent 85%, rgba(140, 100, 30, 0.7) 100%), ' +
        'linear-gradient(to bottom, rgba(140, 100, 30, 0.7) 0%, transparent 15%, transparent 85%, rgba(140, 100, 30, 0.7) 100%)',
      boxShadow:
        'inset 0 0 80px 30px rgba(160, 120, 40, 0.35), ' +
        'inset 0 0 200px 60px rgba(120, 80, 20, 0.2)',
      border: '3px solid rgba(200, 168, 94, 0.35)',
    });
    document.body.appendChild(borderOverlay);

    try {
      // 如果已经预加载了同一个视频，直接从预加载元素同步 src
      if (this._preloadedVideoSrc === scene.video && this._preloadVideoEl) {
        // 预加载的视频已经缓存，直接设置 src 并播放
        this._videoEl.src = scene.video;
      } else {
        this._videoEl.src = scene.video;
      }

      // 先显示视频元素
      this._videoEl.style.display = 'block';
      this._videoEl.style.opacity = '1';

      // 关键修复：先 muted 播放以通过浏览器的自动播放策略
      // 因为 async/await 会丢失用户手势上下文
      this._videoEl.muted = true;
      this._videoEl.load();

      // 等待视频就绪
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Video load timeout'));
        }, 15000);
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('Video load error')); };
        const cleanup = () => {
          clearTimeout(timeout);
          this._videoEl.removeEventListener('canplay', onReady);
          this._videoEl.removeEventListener('canplaythrough', onReady);
          this._videoEl.removeEventListener('error', onError);
        };
        this._videoEl.addEventListener('canplay', onReady, { once: true });
        this._videoEl.addEventListener('canplaythrough', onReady, { once: true });
        this._videoEl.addEventListener('error', onError, { once: true });

        // 如果视频已经就绪（从缓存），立即 resolve
        if (this._videoEl.readyState >= 3) {
          cleanup();
          resolve();
        }
      });

      // 开始播放（muted 状态下可以通过自动播放策略）
      await this._videoEl.play();

      // 播放成功后取消静音
      this._videoEl.muted = false;

      // 黑场淡出 + 边框渐显
      this._fadeOverlay.style.opacity = '0';
      this._fadeOverlay.classList.remove('active');
      requestAnimationFrame(() => { borderOverlay.style.opacity = '1'; });

      // 等待视频播放完毕（或用户跳过）
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const cleanup = () => {
          this._videoEl.removeEventListener('ended', done);
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPtr);
        };
        const onKey = (e) => { if (e.key !== undefined) done(); };
        const onPtr = () => done();
        this._videoEl.addEventListener('ended', done, { once: true });
        document.addEventListener('keydown', onKey, { once: true });
        document.addEventListener('pointerdown', onPtr, { once: true });
      });
    } catch (err) {
      console.warn('[AppCore] Video playback failed:', err);
    }

    // 清理视频
    this._videoEl.pause();
    this._videoEl.style.display = 'none';
    this._videoEl.removeAttribute('src');
    this._videoEl.load();
    if (borderOverlay.parentNode) {
      borderOverlay.style.opacity = '0';
      setTimeout(() => borderOverlay.remove(), 1600);
    }

    this._onVideoEnd();
  }

  _onVideoEnd() {
    // 显示"再拨一曲"提示
    if (this._waveHint) {
      this._waveHint.style.opacity = '0';
      this._waveHint.style.display = 'none';
    }
    const subtitle = this._sceneTitle.querySelector('p');
    if (subtitle) {
      subtitle.style.display = '';
      subtitle.textContent = '轻触屏幕或按任意键，再拨一曲';
    }

    if (this._currentScene) {
      this._sceneTitleText.textContent = this._currentScene.title;
    }
    this._sceneTitle.style.transition = 'opacity 2s ease';
    this._sceneTitle.style.opacity = '1';
    this._videoWatched = true; // 视频已观看，下次点击进入下一关
    this.isSettled = true;
    this.state = 'settling';
  }

  /* ═══════════════ 鼠标 / 触屏兜底 ═══════════════ */

  _bindPointerFallback() {
    const canvas = this.canvasManager.canvas;

    const onMove = (e) => {
      if (this.state !== 'playing') return;

      const rect = canvas.getBoundingClientRect();
      let clientX, clientY;

      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }

      const normX = (clientX - rect.left) / rect.width;
      const normY = (clientY - rect.top) / rect.height;

      this.canvasManager.setFingerPos(normX, normY);
      this._checkStringCollision(normX, normY);

      this._lastMouseX = normX;
      this._lastMouseY = normY;
    };

    const onLeave = () => {
      this.canvasManager.clearFinger();
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('touchmove', onMove, { passive: true });
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('touchend', onLeave);

    // 结算后：点击屏幕 或 按任意键 → 播放视频 或 进入下一关
    const goNext = () => {
      if (!this.isSettled) return;
      if (this.state === 'video') return; // 视频播放中不处理
      if (this.state === 'settling') {
        this.isSettled = false;
        if (this._currentScene && this._currentScene.video && !this._videoWatched) {
          // 有视频 且 尚未观看 → 播放视频
          this._playSceneVideo();
        } else {
          // 无视频 或 已观看过 → 进入下一关
          this.initRandomScene();
        }
      }
    };
    document.addEventListener('pointerdown', goNext);
    document.addEventListener('keydown', goNext);
  }

  /* ═══════════════ 碰撞检测 ═══════════════ */

  _checkStringCollision(normX, normY) {
    const prevX = this._hasHandTracking ? this._lastFingerX : this._lastMouseX;
    if (prevX < 0) {
      // 第一帧，记录位置，跳过碰撞检测
      if (this._hasHandTracking) this._lastFingerX = normX;
      else this._lastMouseX = normX;
      return;
    }

    // 冷却衰减
    for (let i = 0; i < 2; i++) {
      if (this._pluckCooldown[i] > 0) this._pluckCooldown[i]--;
    }

    this.canvasManager.strings.forEach((s, idx) => {
      const stringX = s.xRatio;
      const crossed = (prevX < stringX && normX >= stringX) ||
                      (prevX > stringX && normX <= stringX);

      if (crossed && this._pluckCooldown[idx] <= 0) {
        // 音频
        this.audioManager.triggerPurePluck();

        // 琴弦震动（hitY = 当前手指 Y 坐标）
        this.canvasManager.bounceString(idx, normY);

        // 冷却 8 帧 ≈ 130ms
        this._pluckCooldown[idx] = 8;

        // 拨弦计数
        this._pluckCount++;

        // 水墨擦除（在手指位置）
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const logicalW = this.canvasManager.canvas.width / dpr;
        const logicalH = this.canvasManager.canvas.height / dpr;

        // 更新掩码（穿透毛玻璃）
        this.canvasManager.drawInkToMask(normX * logicalW, normY * logicalH);

        // 动画水墨圈（视觉效果）
        this.canvasManager.addInkCircle(normX * logicalW, normY * logicalH);

        // 检查结算
        if (this._pluckCount >= this._pluckThreshold) {
          this._settle();
        }
      }
    });
  }

  /* ═══════════════ 场景过渡 ═══════════════ */

  /**
   * 初始化随机场景 — 全黑 → 毛玻璃渐显
   *
   * 1. 黑场渐入 + 声音淡出（1.5s）
   * 2. 热重载新场景
   * 3. 黑场渐出 — 毛玻璃摄像头像拨开迷雾般浮现（1.5s）
   */
  async initRandomScene(skipFadeIn) {
    if (this.state === 'loading') return;
    this.state = 'loading';
    this.isSettled = false;

    // 隐藏结算标题
    this._sceneTitle.style.opacity = '0';

    // ── Phase 1: 黑场渐入 + 声音淡出 ──
    this._fadeOverlay.classList.add('active');
    if (!skipFadeIn) {
      const fadeInP = this._animateOverlay(0, 1, 1500);
      const audioFadeP = this.audioManager.fadeOutCurrentAudio(1500);
      await Promise.all([fadeInP, audioFadeP]);
    } else {
      this.audioManager.fadeOutCurrentAudio(500);
    }

    // ── Phase 2: 热重载新场景 ──
    this.canvasManager.resetAll();
    this._pluckCount = 0;
    this._pluckThreshold = 12 + Math.floor(Math.random() * 8);
    this._lastFingerX = -1;
    this._lastFingerY = -1;
    this._lastMouseX = -1;
    this._lastMouseY = -1;

    const scene = this._pickRandomScene();
    this._currentScene = scene;

    // 等待背景图片 + 音频全部加载完成，再做渐出
    await Promise.all([
      this.canvasManager.setBackground(scene.bg, scene.bgColor),
      this.audioManager.loadSceneAudio(scene),
    ]);

    // ── Phase 3: 黑场渐出（迷雾散开，毛玻璃摄像头渐显） ──
    await this._animateOverlay(1, 0, 1500);
    this._fadeOverlay.classList.remove('active');

    this.state = 'playing';
  }

  /**
   * 通关结算
   */
  async _settle() {
    if (this.state === 'settling' || this.state === 'video') return;
    this.state = 'settling';
    this.isSettled = false;
    this._videoWatched = false; // 新场景，视频尚未观看

    this.audioManager.playEndingMusic();

    // 水墨润开全图展开（2s），图片完全显现后展示文字
    await this.canvasManager.revealAll();

    if (this._currentScene) {
      this._sceneTitleText.textContent = this._currentScene.title;
    }

    // 预加载当前场景视频（后台缓存，加速后续播放）
    this._preloadSceneVideo(this._currentScene);

    // 显示点击提示（有视频时提示观看影像，无视频时提示进入下一关）
    const subtitle = this._sceneTitle.querySelector('p');
    if (subtitle) {
      subtitle.style.display = '';
      if (this._currentScene && this._currentScene.video) {
        subtitle.textContent = '点击任意处，观看影像';
      } else {
        subtitle.textContent = '轻触屏幕或按任意键，再拨一曲';
      }
    }
    if (this._waveHint) {
      this._waveHint.style.opacity = '0';
      this._waveHint.style.display = 'none';
    }
    this._sceneTitle.style.transition = 'opacity 2s ease';
    this._sceneTitle.style.opacity = '1';

    // 短暂延迟后允许点击
    setTimeout(() => {
      this.isSettled = true;
    }, 800);
  }

  /**
   * 随机选取未使用过的场景
   */
  _pickRandomScene() {
    if (this._usedSceneIds.size >= SCENE_POOL.length) {
      this._usedSceneIds.clear();
    }
    const available = SCENE_POOL.filter((s) => !this._usedSceneIds.has(s.id));
    const scene = available[Math.floor(Math.random() * available.length)];
    this._usedSceneIds.add(scene.id);
    return scene;
  }

  /**
   * 黑场遮罩动画（ease-in-out）
   */
  _animateOverlay(from, to, duration) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        this._fadeOverlay.style.opacity = from + (to - from) * eased;

        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /* ═══════════════ 渲染循环 ═══════════════ */

  _tick() {
    this.canvasManager.render();
    this._rafId = requestAnimationFrame(this._tick);
  }

  /* ═══════════════ 销毁 ═══════════════ */

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._mpCamera) this._mpCamera.stop();
    if (this._hands) this._hands.close();
    this.audioManager.destroyAll();
  }
}
