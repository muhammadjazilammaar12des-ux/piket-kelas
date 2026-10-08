

/* =========================================================
   OFFLINE-FIRST SHELL — Service Worker registration
   The application already persists reports/evidence locally; the SW
   adds resilient app-shell availability during blank-spot/offline use.
   ========================================================= */
(function registerOfflineServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = new URL('./sw.js', window.location.href);
  navigator.serviceWorker.register(swUrl.href, { scope: './' })
    .then(registration => {
      // Nudge a waiting worker to activate without interrupting the user.
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    })
    .catch(error => {
      console.warn('Offline shell: Service Worker registration failed.', error);
    });
})();
'use strict';

    // v44: Announcer attendance-aware — membaca laporan hari ini, menyimpan snapshot sementara, dan hanya mengumumkan siswa yang benar-benar belum tercatat hadir.
    // v36: fixes image-mode face verification, partial cloud-row recovery, keyboard tabs, navigation guards, and calendar-accurate chat scheduling.

    /* =========================================================
       KONFIGURASI — aman diubah
       ========================================================= */
    const DEFAULT_SUPABASE = {
      url: '',
      key: '',
      bucket: 'piket-foto'
    };

    const DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
    const DAY_INDEX_TO_NAME = ['Minggu', ...DAYS, 'Sabtu'];
    const EMPTY_IMAGE_SRC = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%271%27 height=%271%27 viewBox=%270 0 1 1%27/%3E';

    const STORAGE = {
      config: 'piket_config_v3',
      reports: 'piket_reports_v3',
      draft: 'piket_draft_v3',
      submittedPrefix: 'piket_submitted_v3_',
      perfMode: 'piket_perf_mode_v3',
      deletedReports: 'piket_deleted_reports_v1',
      announcerEnabled: 'piket_announcer_enabled_v1',
      announcerSpokenPrefix: 'piket_announcer_spoken_v1_',
      announcerAttendancePrefix: 'piket_announcer_attendance_v1_'
    };

    const State = {
      config: null,
      camStream: null,
      camFacingMode: 'environment',
      photoTarget: 'anggota',
      blobAnggota: null,
      blobKondisi: null,
      urlAnggota: null,
      urlKondisi: null,
      aiAnalysis: null,
      aiRunToken: 0,
      aiController: null,
      submitInFlight: false,
      pendingDeleteId: null,
      currentPanel: 'home',
      cameraStarting: false,
      performance: null,
      serverOffsetMs: 0,
      timeSynced: false,
      timeSyncSource: 'device',
      timeAnchorServerMs: null,
      timeAnchorPerfMs: null,
      timeLastSyncPerfMs: 0,
      sessionStartedAt: performance.now(),
      supabaseClient: null,
      quickPanelOpen: false,
      uiBrightness: 75,
      motionIntensity: 70,
      deepAR: null,
      deepARBeauty: null,
      deepARInitPromise: null,
      deepARError: null,
      faceDetector: null,
      faceDetectorLoading: false,
      faceDetectionActive: false,
      faceDetectionStable: 0,
      faceDetectionCount: 0,
      submittedTodayKey: null
    };

    /* =========================================================
       CONNECTION / REACHABILITY — navigator.onLine hanya indikator awal.
       Probe network nyata melewati cache Service Worker sehingga status
       ONLINE berarti origin aplikasi benar-benar dapat dijangkau.
       ========================================================= */
    const Connection = {
      status: 'unknown',
      latencyMs: null,
      checkedAt: 0,
      failureStreak: 0,
      probeInFlight: null,
      timer: 0,
      generation: 0,
      PROBE_TIMEOUT: 3500,
      ONLINE_INTERVAL: 45000,
      OFFLINE_INTERVAL: 12000,

      isUsable() {
        return this.status === 'online';
      },

      snapshot() {
        return {
          status: this.status,
          latencyMs: this.latencyMs,
          checkedAt: this.checkedAt,
          browserOnline: navigator.onLine !== false,
          failureStreak: this.failureStreak
        };
      },

      render() {
        const online = this.status === 'online';
        const checking = this.status === 'unknown';
        const badge = Util.el('student-online-badge');
        if (badge) {
          badge.innerHTML = checking
            ? '<i aria-hidden="true" class="fa-solid fa-circle-notch fa-spin"></i> Memeriksa koneksi…'
            : online
              ? '<i aria-hidden="true" class="fa-solid fa-wifi"></i> Online'
              : '<i aria-hidden="true" class="fa-solid fa-cloud-arrow-down"></i> Offline';
          badge.classList.toggle('student-online-live', online && !document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced'));
        }
        const quickValue = Util.el('quick-online-value');
        const quickDot = Util.el('quick-online-dot');
        if (quickValue) quickValue.textContent = checking ? 'Memeriksa…' : (online ? 'Online' : 'Offline');
        quickDot?.classList.toggle('offline', !online);
      },

      applyStatus(status, { latencyMs = null, reason = '' } = {}) {
        const next = status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'unknown';
        const changed = this.status !== next;
        this.status = next;
        this.latencyMs = Number.isFinite(latencyMs) ? Math.round(latencyMs) : null;
        this.checkedAt = Date.now();
        this.render();

        if (changed) {
          window.dispatchEvent(new CustomEvent('piket:connectionchange', {
            detail: this.snapshot()
          }));
        }
        if (reason === 'browser-offline' && next === 'offline') {
          this.failureStreak = Math.max(2, this.failureStreak);
        }
      },

      async probe(reason = 'manual', { force = false } = {}) {
        if (this.probeInFlight && !force) return this.probeInFlight;

        const generation = ++this.generation;
        const url = new URL('./sw.js?__piket_probe=' + Date.now().toString(36), window.location.href);
        const controller = new AbortController();
        const started = performance.now();
        const timeoutId = window.setTimeout(() => controller.abort(), this.PROBE_TIMEOUT);

        this.probeInFlight = (async () => {
          try {
            this.render();
            const response = await fetch(url.href, {
              method: 'GET',
              cache: 'no-store',
              credentials: 'same-origin',
              redirect: 'follow',
              signal: controller.signal,
              headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' }
            });

            const responseOrigin = (() => {
              try { return new URL(response.url).origin; } catch (_) { return ''; }
            })();

            const reachable =
              responseOrigin === window.location.origin &&
              response.type === 'basic' &&
              response.status >= 200 &&
              response.status < 500;

            if (!reachable) throw new Error(`Probe HTTP ${response.status}`);

            if (generation !== this.generation) return false;
            this.failureStreak = 0;
            this.applyStatus('online', {
              latencyMs: performance.now() - started,
              reason
            });
            return true;
          } catch (error) {
            if (generation !== this.generation) return false;
            this.failureStreak += 1;

            // Browser online + one transient timeout belum langsung dianggap
            // offline. Dua kegagalan probe berturut-turut baru menurunkan status.
            if (navigator.onLine === false || this.failureStreak >= 2) {
              this.applyStatus('offline', { reason });
            } else {
              this.checkedAt = Date.now();
              this.render();
            }
            return false;
          } finally {
            window.clearTimeout(timeoutId);
          }
        })().finally(() => {
          this.probeInFlight = null;
        });

        return this.probeInFlight;
      },

      scheduleNext() {
        window.clearTimeout(this.timer);
        const delay = this.status === 'online' ? this.ONLINE_INTERVAL : this.OFFLINE_INTERVAL;
        this.timer = window.setTimeout(() => {
          void this.probe('periodic').finally(() => this.scheduleNext());
        }, delay);
      },

      async start() {
        this.render();

        window.addEventListener('online', () => {
          this.failureStreak = 0;
          void this.probe('browser-online', { force:true }).finally(() => this.scheduleNext());
        });

        window.addEventListener('offline', () => {
          this.failureStreak = Math.max(2, this.failureStreak);
          this.applyStatus('offline', { reason:'browser-offline' });
          this.scheduleNext();
        });

        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            void this.probe('visibility').finally(() => this.scheduleNext());
          }
        });

        window.addEventListener('pageshow', () => {
          void this.probe('pageshow').finally(() => this.scheduleNext());
        });

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        connection?.addEventListener?.('change', () => {
          void this.probe('network-change').finally(() => this.scheduleNext());
        });

        await this.probe('startup', { force:true });
        this.scheduleNext();
      }
    };

    // Warn only while photo evidence exists in memory. Keeping the
    // beforeunload listener inactive otherwise preserves normal bfcache
    // eligibility on browsers that account for this listener.
    let unsavedChangesGuardActive = false;
    const unsavedChangesGuard = event => {
      event.preventDefault();
      event.returnValue = '';
    };
    const setUnsavedChangesGuard = active => {
      const next = Boolean(active);
      if (next === unsavedChangesGuardActive) return;
      unsavedChangesGuardActive = next;
      if (next) {
        window.addEventListener('beforeunload', unsavedChangesGuard);
      } else {
        window.removeEventListener('beforeunload', unsavedChangesGuard);
      }
    };

    /* =========================================================
       UTILITAS
       ========================================================= */
    const Util = {
      el(id) { return document.getElementById(id); },
      qs(sel, root = document) { return root.querySelector(sel); },
      qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },
      escapeHTML(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      },
      safeHttpUrl(value) {
        try {
          const url = new URL(String(value || ''), location.href);
          return /^https?:$/i.test(url.protocol) ? url.href : '';
        } catch (_) {
          return '';
        }
      },
      safeReportImageUrl(value) {
        const safe = this.safeHttpUrl(value);
        const cfg = State.config?.supabase;
        if (!safe || !cfg?.url || !cfg?.bucket) return '';
        try {
          const url = new URL(safe);
          const projectUrl = new URL(cfg.url);
          if (url.origin !== projectUrl.origin) return '';

          const bucket = String(cfg.bucket).trim();
          const prefixes = [
            `/storage/v1/object/public/${encodeURIComponent(bucket)}/`,
            `/storage/v1/object/public/${bucket}/`,
            `/public/${encodeURIComponent(bucket)}/`,
            `/public/${bucket}/`
          ];

          return prefixes.some(prefix => url.pathname.startsWith(prefix))
            ? url.href
            : '';
        } catch (_) {
          return '';
        }
      },
      sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
      safeJsonParse(raw, fallback) {
        try { return JSON.parse(raw); } catch (_) { return fallback; }
      },
      uid(prefix = 'id') {
        if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
        return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      },
      clamp(value, min, max) { return Math.min(max, Math.max(min, value)); },
      bytesToMB(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; },
      isTypingTarget(target) {
        return target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      }
    };

    const UI = {
      toast(message, type = 'success') {
        const container = Util.el('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        const colors = { success: '#059669', error: '#dc2626', info: '#2563eb', warning: '#d97706' };
        const icons = { success: 'check-circle', error: 'triangle-exclamation', info: 'circle-info', warning: 'circle-exclamation' };
        toast.style.background = colors[type] || colors.info;
        toast.innerHTML = `<i aria-hidden="true" class="fa-solid fa-${icons[type] || icons.info}"></i><span>${Util.escapeHTML(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3600);
      },
      setButtonBusy(button, busy, busyText = 'Memproses…') {
        if (!button) return;
        if (busy) {
          if (!button.dataset.oldText) button.dataset.oldText = button.innerHTML;
          button.disabled = true;
          button.classList.add('loading-pulse');
          button.innerHTML = `<i aria-hidden="true" class="fa-solid fa-spinner fa-spin"></i> ${Util.escapeHTML(busyText)}`;
        } else {
          button.disabled = false;
          button.classList.remove('loading-pulse');
          if (button.dataset.oldText) {
            button.innerHTML = button.dataset.oldText;
            delete button.dataset.oldText;
          }
        }
      },
      animatePanel(panel) {
        if (!panel || document.body.classList.contains('motion-low') || document.body.classList.contains('motion-reduced')) return;
        panel.classList.remove('motion-enter');
        void panel.offsetWidth;
        panel.classList.add('motion-enter');
        window.setTimeout(() => panel.classList.remove('motion-enter'), 900);
      },
      showSuccess(message = 'Laporan piket telah tersimpan.') {
        const overlay = Util.el('success-overlay');
        const text = Util.el('success-overlay-text');
        if (!overlay) return;
        if (text) text.textContent = message;
        overlay.hidden = false;
        window.clearTimeout(this._successTimer);
        this._successTimer = window.setTimeout(() => { overlay.hidden = true; }, 1750);
      },
      pulsePrimary(buttonId) {
        const button = Util.el(buttonId);
        if (!button || button.disabled) return;
        const reduced = document.body.classList.contains('motion-low') || document.body.classList.contains('motion-reduced');
        button.classList.toggle('btn-pulse', !reduced);
      },
      flashCapture() {
        const wrap = Util.el('camera-stream')?.closest('.camera-wrap');
        const success = Util.el('capture-success');
        if (!wrap || !success) return;
        const reduced = document.body.classList.contains('motion-low') || document.body.classList.contains('motion-reduced');
        if (reduced) return;
        wrap.classList.remove('shutter-flash');
        success.classList.remove('show');
        void wrap.offsetWidth;
        void success.offsetWidth;
        wrap.classList.add('shutter-flash');
        success.classList.add('show');
        window.setTimeout(() => {
          wrap.classList.remove('shutter-flash');
          success.classList.remove('show');
        }, 1100);
      },
      _successTimer: null,
      setStatus(el, message, type = 'info') {
        if (!el) return;
        el.className = `status ${type}`;
        el.textContent = message;
      }
    };

    /* =========================================================
       DEVICE / PERFORMANCE AUTO-TUNING
       ========================================================= */
    /* =========================================================
       DEEPAR BEAUTY — otomatis pada foto anggota.
       Isi licenseKey dengan Web App key DeepAR Anda untuk mengaktifkan.
       Tanpa key valid, kamera bawaan aplikasi tetap digunakan sebagai fallback.
       ========================================================= */
    const DEEPAR_CONFIG = {
      enabled: false,
      licenseKey: '',
      sdkUrl: 'https://cdn.jsdelivr.net/npm/deepar@5.6.22/js/deepar.esm.js',
      beautyModuleUrl: 'https://cdn.jsdelivr.net/npm/@deepar/beauty@1.1.0-beta/dist/beauty-deepar.esm.js',
      beautyRootPath: 'https://cdn.jsdelivr.net/npm/@deepar/beauty@1.1.0-beta/dist/',
      skinSmoothing: 70
    };

    const DeepARCamera = {
      _gen: 0,
      _engineOwnerGen: 0,
      configured() {
        const key = String(DEEPAR_CONFIG.licenseKey || '').trim();
        return Boolean(DEEPAR_CONFIG.enabled && key && !key.includes('MASUKKAN_LICENSE_KEY'));
      },
      async loadModules() {
        if (State.deepARInitPromise) return State.deepARInitPromise;

        const task = Promise.all([
          import(DEEPAR_CONFIG.sdkUrl),
          import(DEEPAR_CONFIG.beautyModuleUrl)
        ]).then(([deeparModule, beautyModule]) => ({
          deeparModule,
          beautyModule
        }));

        let trackedTask;
        trackedTask = task.catch(error => {
          if (State.deepARInitPromise === trackedTask) {
            State.deepARInitPromise = null;
          }
          throw error;
        });

        State.deepARInitPromise = trackedTask;
        return trackedTask;
      },
      async initialize(ownerGen = this._gen) {
        if (!this.configured()) return false;

        if (State.deepAR && State.deepARBeauty) return true;

        // Bersihkan engine parsial dari inisialisasi sebelumnya sebelum membuat engine baru.
        if (State.deepAR && !State.deepARBeauty) {
          try { State.deepAR.stopCamera?.(); } catch (_) {}
          try { State.deepAR.shutdown?.(); } catch (_) {}
          State.deepAR = null;
          State.deepARBeauty = null;
        }

        const preview = Util.el('deepar-preview');
        if (!preview) return false;

        const { deeparModule, beautyModule } = await this.loadModules();
        if (ownerGen !== this._gen) return false;

        const deepar = deeparModule.default || deeparModule;
        const Beauty = beautyModule.default || beautyModule;
        let engine = null;

        try {
          engine = await deepar.initialize({
            licenseKey: DEEPAR_CONFIG.licenseKey,
            previewElement: preview,
            additionalOptions: {
              cameraConfig: { disableDefaultCamera: true },
              hint: ['faceInit']
            }
          });

          if (ownerGen !== this._gen) {
            try { engine?.stopCamera?.(); } catch (_) {}
            try { engine?.shutdown?.(); } catch (_) {}
            return false;
          }

          const profile = Performance.profiles[State.performance?.mode || 'balanced'];
          engine?.setFps?.(profile?.cameraFps || 24);

          const beauty = await Beauty.initializeBeauty(engine, DEEPAR_CONFIG.beautyRootPath);

          if (ownerGen !== this._gen) {
            try { engine?.stopCamera?.(); } catch (_) {}
            try { engine?.shutdown?.(); } catch (_) {}
            return false;
          }

          beauty?.skinSmoothing?.set?.(DEEPAR_CONFIG.skinSmoothing);

          // Publish ke State hanya setelah seluruh initialization berhasil.
          State.deepAR = engine;
          State.deepARBeauty = beauty;
          State.deepARError = null;
          return true;
        } catch (error) {
          try { engine?.stopCamera?.(); } catch (_) {}
          try { engine?.shutdown?.(); } catch (_) {}
          throw error;
        }
      },
      async setBeauty(enabled) {
        try {
          if (State.deepARBeauty?.disable) State.deepARBeauty.disable(!enabled);
        } catch (error) {
          console.warn('DeepAR Beauty toggle failed:', error);
        }
      },
      showPreview(show) {
        const preview = Util.el('deepar-preview');
        const video = Util.el('camera-stream');
        if (preview) preview.hidden = !show;
        if (video) video.hidden = show;
      },
      async start() {
        if (!this.configured()) return false;
        if (!State.performance) Performance.apply();
        const gen = ++this._gen;
        let engine = null;

        const cleanupStaleEngine = () => {
          if (!engine) return;

          const ownedByAttempt = this._engineOwnerGen === gen;
          const currentlyUnowned = this._engineOwnerGen === 0;

          if (
            State.deepAR !== engine ||
            ownedByAttempt ||
            currentlyUnowned
          ) {
            try { engine.stopCamera?.(); } catch (_) {}
            try { engine.shutdown?.(); } catch (_) {}

            if (State.deepAR === engine && (ownedByAttempt || currentlyUnowned)) {
              State.deepAR = null;
              State.deepARBeauty = null;
            }

            if (this._engineOwnerGen === gen) {
              this._engineOwnerGen = 0;
            }
          }
        };

        try {
          const initialized = await this.initialize(gen);
          if (!initialized || gen !== this._gen) return false;
          engine = State.deepAR;
          if (!engine) return false;

          if (gen !== this._gen) {
            cleanupStaleEngine();
            return false;
          }

          // Tandai engine sebagai milik attempt ini sebelum operasi async dimulai.
          // Attempt lain tidak boleh membersihkan engine yang sudah diambil alih.
          this._engineOwnerGen = gen;

          const profile = Performance.profiles[State.performance?.mode || 'balanced'];
          await engine.startCamera({
            mirror: State.camFacingMode === 'user',
            mediaStreamConstraints: {
              video: {
                facingMode: { ideal: State.camFacingMode },
                width: { ideal: profile.cameraWidth },
                height: { ideal: profile.cameraHeight },
                frameRate: { ideal: profile.cameraFps, max: profile.cameraFps }
              },
              audio: false
            }
          });

          if (
            gen !== this._gen ||
            State.deepAR !== engine ||
            this._engineOwnerGen !== gen
          ) {
            cleanupStaleEngine();
            return false;
          }

          await this.setBeauty(State.photoTarget === 'anggota');

          if (
            gen !== this._gen ||
            State.deepAR !== engine ||
            this._engineOwnerGen !== gen
          ) {
            cleanupStaleEngine();
            return false;
          }

          this.showPreview(true);
          return true;
        } catch (error) {
          if (gen !== this._gen) {
            cleanupStaleEngine();
            return false;
          }
          State.deepARError = error;
          console.warn('DeepAR fallback to native camera:', error);
          this.showPreview(false);
          if (this._engineOwnerGen === gen) {
            this._engineOwnerGen = 0;
          }
          try { engine?.stopCamera?.(); } catch (_) {}
          if (State.deepAR === engine) {
            try { engine?.shutdown?.(); } catch (_) {}
            State.deepAR = null;
            State.deepARBeauty = null;
          } else if (engine) {
            try { engine?.shutdown?.(); } catch (_) {}
          }
          return false;
        }
      },
      stop() {
        this._gen++;
        FaceDetection.stop();
        this._engineOwnerGen = 0;
        try { State.deepAR?.stopCamera?.(); } catch (_) {}

        // Setelah native fallback mengambil alih, jangan biarkan initialization
        // promise stale menjadi owner lifecycle percobaan DeepAR berikutnya.
        if (!State.deepAR) {
          State.deepARInitPromise = null;
        }

        this.showPreview(false);
      },
      async switchCamera() {
        if (!State.deepAR) return false;

        const gen = ++this._gen;
        const engine = State.deepAR;

        const cleanupStaleEngine = () => {
          const ownedByAttempt = this._engineOwnerGen === gen;
          const currentlyUnowned = this._engineOwnerGen === 0;

          if (
            State.deepAR !== engine ||
            ownedByAttempt ||
            currentlyUnowned
          ) {
            try { engine.stopCamera?.(); } catch (_) {}

            if (State.deepAR === engine && (ownedByAttempt || currentlyUnowned)) {
              State.deepAR = null;
              State.deepARBeauty = null;
            }

            if (this._engineOwnerGen === gen) {
              this._engineOwnerGen = 0;
            }
          }
        };

        this._engineOwnerGen = gen;

        try {
          engine.stopCamera();
          await engine.startCamera({
            mirror: State.camFacingMode === 'user',
            mediaStreamConstraints: { video: { facingMode: { ideal: State.camFacingMode } }, audio: false }
          });

          if (
            gen !== this._gen ||
            State.deepAR !== engine ||
            this._engineOwnerGen !== gen
          ) {
            cleanupStaleEngine();
            return false;
          }

          await this.setBeauty(State.photoTarget === 'anggota');

          if (
            gen !== this._gen ||
            State.deepAR !== engine ||
            this._engineOwnerGen !== gen
          ) {
            cleanupStaleEngine();
            return false;
          }

          this.showPreview(true);
          return true;
        } catch (error) {
          if (gen !== this._gen) {
            cleanupStaleEngine();
            return false;
          }
          if (this._engineOwnerGen === gen) {
            this._engineOwnerGen = 0;
          }
          try { engine.stopCamera?.(); } catch (_) {}
          console.warn('DeepAR switch camera failed:', error);
          return false;
        }
      },
      async snapshot() {
        if (!State.deepAR) return null;
        return ImagePipeline.dataUrlToBlob(await State.deepAR.takeScreenshot());
      },
      async shutdown() {
        // Invalidate seluruh operasi DeepAR yang masih in-flight.
        this._gen++;
        this._engineOwnerGen = 0;

        // Lepaskan ownership sebelum teardown agar promise lama
        // selalu melihat dirinya sebagai stale.
        const engine = State.deepAR;
        State.deepAR = null;
        State.deepARBeauty = null;
        State.deepARInitPromise = null;

        try { engine?.stopCamera?.(); } catch (_) {}
        try { engine?.shutdown?.(); } catch (_) {}
        this.showPreview(false);
      }
    };

    const Performance = {
      profiles: {
        low: {
          label:'Hemat', ai:true, maxWidth:640, quality:.60,
          cameraWidth:640, cameraHeight:480, cameraFps:20,
          aiTimeout:5000, aiInterval:320, aiScale:.72, aiMinSize:44, aiConfidence:.24,
          animation:false, gradient:false, cameraPulse:false, scan:false, progress:false
        },
        balanced: {
          label:'Seimbang', ai:true, maxWidth:960, quality:.68,
          cameraWidth:960, cameraHeight:540, cameraFps:24,
          aiTimeout:6500, aiInterval:180, aiScale:.84, aiMinSize:42, aiConfidence:.24,
          animation:true, gradient:true, cameraPulse:true, scan:true, progress:true
        },
        high: {
          label:'Maksimal', ai:true, maxWidth:1280, quality:.74,
          cameraWidth:1280, cameraHeight:720, cameraFps:30,
          aiTimeout:9000, aiInterval:120, aiScale:1, aiMinSize:40, aiConfidence:.23,
          animation:true, gradient:true, cameraPulse:true, scan:true, progress:true
        }
      },
      deviceInfo() {
        const nav = navigator;
        const ua = String(nav.userAgent || '');
        const isIOS = /iPhone|iPad|iPod/i.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
        const isAndroid = /Android/i.test(ua);
        const isMobile = isIOS || isAndroid || /Mobile/i.test(ua);
        const cores = Number(nav.hardwareConcurrency || 0);
        const memory = Number(nav.deviceMemory || 0);
        const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
        const effectiveType = String(connection?.effectiveType || '');
        const saveData = Boolean(connection?.saveData);
        const dpr = Math.max(1, Math.min(4, Number(window.devicePixelRatio || 1)));
        const screenWidth = Number(window.screen?.width || 0);
        const screenHeight = Number(window.screen?.height || 0);
        const viewportWidth = Math.max(1, Number(window.innerWidth || screenWidth || 1));
        const viewportHeight = Math.max(1, Number(window.innerHeight || screenHeight || 1));
        const viewportPixels = Math.round(viewportWidth * viewportHeight);
        const touch = Number(nav.maxTouchPoints || 0);

        let jsHeapSizeLimit = 0;
        try {
          jsHeapSizeLimit = Number(window.performance?.memory?.jsHeapSizeLimit || 0);
        } catch (_) {}

        let webgl = {
          hasWebGL: false,
          hasWebGL2: false,
          maxTextureSize: 0,
          maxViewportWidth: 0,
          renderer: '',
          isSoftwareRenderer: false
        };

        try {
          const canvas = document.createElement('canvas');
          const gl2 = canvas.getContext('webgl2', {
            antialias: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false
          });
          const gl = gl2 || canvas.getContext('webgl', {
            antialias: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false
          });

          if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = debugInfo
              ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '')
              : '';

            const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0);
            const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
            const maxViewportWidth = Number(viewport?.[0] || 0);
            const normalizedRenderer = renderer.toLowerCase();
            const isSoftwareRenderer =
              /swiftshader|llvmpipe|software rasterizer|softpipe|mesa llvmpipe/i.test(normalizedRenderer);

            webgl = {
              hasWebGL: true,
              hasWebGL2: Boolean(gl2),
              maxTextureSize,
              maxViewportWidth,
              renderer,
              isSoftwareRenderer
            };
          }

          canvas.width = 1;
          canvas.height = 1;
        } catch (_) {}

        return {
          isIOS,
          isAndroid,
          isMobile,
          cores,
          memory,
          effectiveType,
          saveData,
          dpr,
          screenWidth,
          screenHeight,
          viewportWidth,
          viewportHeight,
          viewportPixels,
          touch,
          jsHeapSizeLimit,
          ...webgl,
          ua
        };
      },
      detect() {
        const d = this.deviceInfo();
        const saved = Local.get(STORAGE.perfMode, 'auto');
        let score = 50;

        // CPU: jumlah logical cores tetap berguna, tetapi bobot dibuat bertingkat agar
        // perangkat 4/6/8/12+ core tidak terklasifikasi secara terlalu agresif.
        if (d.cores >= 12) score += 24;
        else if (d.cores >= 10) score += 18;
        else if (d.cores >= 8) score += 13;
        else if (d.cores >= 6) score += 7;
        else if (d.cores >= 4) score += 0;
        else if (d.cores > 0) score -= 16;

        // RAM/JS heap: deviceMemory lebih konsisten lintas browser; heap limit hanya
        // dipakai sebagai sinyal tambahan ketika browser mengeksposnya.
        if (d.memory >= 16) score += 15;
        else if (d.memory >= 12) score += 12;
        else if (d.memory >= 8) score += 8;
        else if (d.memory >= 6) score += 4;
        else if (d.memory >= 4) score -= 1;
        else if (d.memory > 0) score -= 19;

        if (d.jsHeapSizeLimit >= 2_000_000_000) score += 4;
        else if (d.jsHeapSizeLimit > 0 && d.jsHeapSizeLimit < 700_000_000) score -= 6;

        // GPU/rendering capability: software WebGL merupakan sinyal kuat bahwa filter,
        // blur, dan compositing berat perlu dihemat.
        if (d.hasWebGL2) score += 4;
        else if (d.hasWebGL) score += 1;

        if (d.maxTextureSize >= 16384) score += 3;
        else if (d.maxTextureSize >= 8192) score += 2;
        else if (d.maxTextureSize > 0 && d.maxTextureSize < 4096) score -= 3;

        if (d.isSoftwareRenderer) score -= 28;

        // Mobile diberi sedikit konservatisme karena pipeline kamera + AI bersamaan
        // lebih sensitif terhadap panas, throttling, dan contention.
        if (d.isMobile) score -= 4;
        if (d.isAndroid && d.cores > 0 && d.cores <= 4 && d.memory > 0 && d.memory <= 4) score -= 8;

        // DPR/viewport sangat tinggi meningkatkan cost compositing, tetapi hanya sedikit.
        if (d.viewportPixels >= 5_000_000) score -= 6;
        else if (d.viewportPixels >= 4_000_000) score -= 3;
        if (d.dpr >= 3.5) score -= 4;

        // Data Saver bukan indikator hardware, tetapi pada mode otomatis kita tetap memilih
        // profil konservatif agar pemuatan model/asset tidak membebani pengguna.
        if (d.saveData) score -= 8;

        score = Util.clamp(Math.round(score), 0, 100);

        let autoMode = score < 42 ? 'low' : score >= 79 ? 'high' : 'balanced';

        if (d.isSoftwareRenderer) autoMode = 'low';
        if (d.saveData) autoMode = 'low';
        if (d.isAndroid && d.memory > 0 && d.memory <= 4) autoMode = 'low';
        if (d.isAndroid && d.cores > 0 && d.cores <= 4 && autoMode === 'high') autoMode = 'balanced';
        if (d.isMobile && d.dpr >= 3.5 && autoMode === 'high') autoMode = 'balanced';

        const mode = ['low','balanced','high'].includes(saved) ? saved : autoMode;
        return {
          mode,
          autoMode,
          score,
          ...d,
          source: saved === 'auto' ? 'auto' : 'manual'
        };
      },
      async calibrateRuntime() {
        if (this._runtimeCalibrationPromise) return this._runtimeCalibrationPromise;
        if (Local.get(STORAGE.perfMode, 'auto') !== 'auto') return null;
        if (!State.performance) return null;

        this._runtimeCalibrationPromise = (async () => {
          // Beri browser waktu menyelesaikan layout/asset awal sehingga sampling tidak
          // ikut menghukum pekerjaan startup yang hanya terjadi sekali.
          await new Promise(resolve => window.setTimeout(resolve, 900));
          if (document.hidden || !State.performance) return null;

          const samples = [];
          let previous = window.performance.now();

          for (let i = 0; i < 24; i += 1) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const now = window.performance.now();
            const delta = now - previous;
            if (delta > 0) samples.push(delta);
            previous = now;
          }

          if (samples.length < 12 || document.hidden || !State.performance) return null;

          const ordered = [...samples].sort((a, b) => a - b);
          const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
          const p95 = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))];
          const longFrameRatio = samples.filter(value => value >= 24).length / samples.length;

          const perf = State.performance;
          perf.frameRuntimeMs = average;
          perf.frameP95Ms = p95;
          perf.frameLongRatio = longFrameRatio;
          perf.runtimeCalibrated = true;

          const isClearlySlow =
            average >= 28 ||
            p95 >= 48 ||
            longFrameRatio >= 0.34;

          const isModeratelyLoaded =
            average >= 21 ||
            p95 >= 34 ||
            longFrameRatio >= 0.20;

          const isStrong =
            average <= 17.5 &&
            p95 <= 24 &&
            longFrameRatio <= 0.08;

          let next = perf.mode;
          if (isClearlySlow) {
            next = 'low';
          } else if (isModeratelyLoaded && next === 'high') {
            next = 'balanced';
          } else if (
            isStrong &&
            next === 'balanced' &&
            Number(perf.score || 0) >= 82 &&
            !perf.isSoftwareRenderer
          ) {
            next = 'high';
          }

          if (next !== perf.mode) {
            perf.mode = next;
            perf.source = 'runtime-calibration';
            document.body.classList.remove('perf-low', 'perf-balanced', 'perf-high');
            document.body.classList.add(`perf-${next}`);
            this.applyMotion(next);
          }

          return perf;
        })().catch(error => {
          console.warn('Performance calibration:', error);
          return null;
        });

        return this._runtimeCalibrationPromise;
      },
      apply(mode = null) {
        if (mode && ['auto','low','balanced','high'].includes(mode)) Local.set(STORAGE.perfMode, mode);
        const savedMode = Local.get(STORAGE.perfMode, 'auto');
        const fresh = this.detect();
        const keepRuntimeDowngrade = !mode && savedMode === 'auto' && State.performance?.source === 'runtime-downgrade';
        if (keepRuntimeDowngrade) {
          fresh.mode = 'low';
          fresh.source = 'runtime-downgrade';
        }
        State.performance = fresh;
        document.body.classList.toggle('perf-low', fresh.mode === 'low');
        document.body.classList.toggle('perf-balanced', fresh.mode === 'balanced');
        document.body.classList.toggle('perf-high', fresh.mode === 'high');

        const profile = this.profiles[fresh.mode];
        this.applyMotion(fresh.mode);
        const details = Util.el('performance-details');
        if (details) {
          const platform = fresh.isAndroid ? 'Android' : fresh.isIOS ? 'iPhone/iPad' : 'Desktop/Browser';
          const chipHint = fresh.isIOS ? ' · chip Apple tidak dibaca browser' : '';
          details.textContent = fresh.source === 'runtime-adaptive'
            ? `Mode ${profile.label} · adaptif runtime · CPU ${fresh.cores || '?'} core · RAM ${fresh.memory ? `~${fresh.memory} GB` : 'tidak tersedia'} · AI ${Number.isFinite(fresh.aiRuntimeEma) ? `${Math.round(fresh.aiRuntimeEma)}ms` : 'menilai…'}`
            : `Mode ${profile.label} · ${platform} · CPU ${fresh.cores || '?'} core · RAM ${fresh.memory ? `~${fresh.memory} GB` : 'tidak tersedia'} · Skor ${fresh.score}/100${chipHint}${fresh.saveData ? ' · Data Saver' : ''}`;
        }
        const modeSelect = Util.el('performance-mode');
        if (modeSelect) modeSelect.value = Local.get(STORAGE.perfMode, 'auto');
        const homePerf = Util.el('home-performance');
        if (homePerf) homePerf.textContent = fresh.source === 'runtime-downgrade' ? 'Hemat (runtime)' : `${profile.label} (${Local.get(STORAGE.perfMode,'auto') === 'auto' ? 'auto' : 'manual'})`;
        return fresh;
      },
      applyMotion(mode) {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
        let desired;

        if (reduce) {
          desired = 'motion-reduced';
        } else {
          // Gunakan state runtime agar slider tetap responsif selama gesture.
          // Persistence dilakukan pada event change, bukan setiap input.
          const custom = Number(State.motionIntensity);
          const effective = Number.isFinite(custom)
            ? (custom < 35 ? 'low' : custom < 70 ? 'balanced' : 'high')
            : mode;
          desired = `motion-${effective}`;
        }

        const motionClasses = [
          'motion-low',
          'motion-balanced',
          'motion-high',
          'motion-reduced'
        ];

        const alreadyCorrect =
          document.body.classList.contains(desired) &&
          motionClasses.every(cls =>
            cls === desired || !document.body.classList.contains(cls)
          );

        if (alreadyCorrect) return;

        document.body.classList.remove(...motionClasses);
        document.body.classList.add(desired);
      },
      imageSettings() {
        const p = this.profiles[State.performance?.mode || 'balanced'];
        return { maxWidth:p.maxWidth, quality:p.quality };
      },
      aiProfile() {
        const mode = State.performance?.mode || 'balanced';
        const p = this.profiles[mode] || this.profiles.balanced;
        return {
          interval: p.aiInterval || 180,
          scale: p.aiScale || 1,
          minSize: p.aiMinSize || 42,
          confidence: p.aiConfidence || 0.24,
          maxFaces: 8
        };
      },
      adaptFromAiRuntime(ms, faceCount = 0) {
        if (!State.performance || !Number.isFinite(ms)) return;
        const perf = State.performance;
        perf.aiRuntimeEma = Number.isFinite(perf.aiRuntimeEma)
          ? (perf.aiRuntimeEma * 0.78 + ms * 0.22)
          : ms;
        perf.aiRuntimeSamples = Math.min(999, Number(perf.aiRuntimeSamples || 0) + 1);
        perf.aiLastFaceCount = Math.min(8, Math.max(0, Number(faceCount) || 0));
        if (Local.get(STORAGE.perfMode, 'auto') !== 'auto' || perf.aiRuntimeSamples < 5) return;

        const now = performance.now();
        const cooldown = Number(perf.aiLastDowngradeAt || 0);
        if (now - cooldown < 8000) return;

        const framePressure =
          Number.isFinite(perf.frameRuntimeMs)
            ? Math.max(0, perf.frameRuntimeMs - 16.7) * 22
            : 0;
        const longFramePressure =
          Number.isFinite(perf.frameLongRatio)
            ? perf.frameLongRatio * 360
            : 0;

        const pressure =
          perf.aiRuntimeEma +
          Math.max(0, perf.aiLastFaceCount - 3) * 90 +
          framePressure +
          longFramePressure;

        let next = perf.mode;
        if (pressure >= 1350) next = 'low';
        else if (pressure >= 920 && perf.mode === 'high') next = 'balanced';
        else if (pressure >= 1080 && perf.mode === 'balanced') next = 'low';

        if (next === perf.mode) return;
        perf.mode = next;
        perf.source = 'runtime-adaptive';
        perf.aiLastDowngradeAt = now;
        document.body.classList.remove('perf-low', 'perf-balanced', 'perf-high');
        document.body.classList.add(`perf-${next}`);
        this.applyMotion(next);

        const details = Util.el('performance-details');
        if (details) details.textContent = `Mode ${this.profiles[next].label} · diturunkan adaptif · AI rata-rata ${Math.round(perf.aiRuntimeEma)}ms`;
        const homePerf = Util.el('home-performance');
        if (homePerf) homePerf.textContent = `${this.profiles[next].label} (adaptif)`;
        const quickPerf = Util.el('quick-performance-value');
        if (quickPerf) quickPerf.textContent = this.profiles[next].label;
        const quickNote = Util.el('quick-performance-note');
        if (quickNote) quickNote.textContent = 'Adaptasi runtime aktif';
      },
      cameraConstraints() {
        const p = this.profiles[State.performance?.mode || 'balanced'];
        const isPortrait = State.photoTarget === 'anggota';
        const landscapeWidth = p.cameraWidth;
        const landscapeHeight = Math.max(1, Math.round(landscapeWidth * (9 / 16)));
        const portraitHeight = landscapeWidth;
        const portraitWidth = Math.max(1, Math.round(portraitHeight * (9 / 16)));
        const width = isPortrait ? portraitWidth : landscapeWidth;
        const height = isPortrait ? portraitHeight : landscapeHeight;
        return {
          video: {
            facingMode: { ideal: State.camFacingMode },
            width: { ideal: width, max: width },
            height: { ideal: height, max: height },
            frameRate: { ideal:p.cameraFps, max:p.cameraFps }
          },
          audio:false
        };
      },
      aiAllowed() {
        const p = State.performance || this.apply();
        return Boolean(this.profiles[p.mode]?.ai);
      },
      aiTimeout() {
        const p = State.performance || this.apply();
        return this.profiles[p.mode]?.aiTimeout || 6000;
      },
      recordAiRuntime(ms, timedOut = false) {
        if (!State.performance || Local.get(STORAGE.perfMode,'auto') !== 'auto') return;
        if (!Number.isFinite(ms)) return;
        if (timedOut || ms >= 7000) {
          State.performance.aiRuntimeEma = 9999;
          State.performance.aiRuntimeSamples = Math.max(5, Number(State.performance.aiRuntimeSamples || 0));
          this.adaptFromAiRuntime(ms, 8);
        } else {
          this.adaptFromAiRuntime(ms, State.faceDetectionCount || 1);
        }
      }
    };

    /* =========================================================
       TIME SYNC — waktu Jakarta berbasis server + jam monotonic sesi
       ========================================================= */
    const Time = {
      zone: 'Asia/Jakarta',
      _syncPromise: null,
      async sync() {
        if (this._syncPromise) return this._syncPromise;

        const run = (async () => {
          // Dua sumber waktu agar satu layanan gratis yang down tidak mengunci pengiriman laporan.
          const sources = [
            async signal => {
              const response = await fetch('https://worldtimeapi.org/api/timezone/Asia/Jakarta', { signal, cache: 'no-store' });
              if (!response.ok) throw new Error('Time service unavailable');
              const data = await response.json();
              const unixMs = Number.isFinite(Number(data?.unixtime)) ? Number(data.unixtime) * 1000 : NaN;
              return Number.isFinite(unixMs) ? unixMs : new Date(data?.datetime).getTime();
            },
            async signal => {
              const response = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=Asia/Jakarta', { signal, cache: 'no-store' });
              if (!response.ok) throw new Error('Time service unavailable');
              const data = await response.json();
              const raw = String(data?.dateTime || '').replace(/(\.\d{3})\d*$/, '$1');
              return raw ? new Date(`${raw}+07:00`).getTime() : NaN; // Asia/Jakarta = UTC+7 tanpa DST
            }
          ];

          const readTimed = async readSource => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 4000);
            try {
              const value = await readSource(controller.signal);
              if (!Number.isFinite(value)) throw new Error('Invalid time response');
              return value;
            } finally {
              window.clearTimeout(timeout);
            }
          };

          let serverMs = NaN;
          try {
            // Race kedua layanan secara paralel agar kegagalan tidak menjumlahkan timeout.
            serverMs = await Promise.any(sources.map(readTimed));
          } catch (_) {
            serverMs = NaN;
          }

          if (Number.isFinite(serverMs)) {
            State.serverOffsetMs = serverMs - Date.now();
            State.timeSynced = true;
            State.timeSyncSource = 'server';
            State.timeAnchorServerMs = serverMs;
            State.timeAnchorPerfMs = performance.now();
            State.timeLastSyncPerfMs = State.timeAnchorPerfMs;
            return this.now();
          }

          // Jangan menghapus anchor server terakhir. Selama halaman masih hidup,
          // performance.now() tetap monotonic dan tidak terpengaruh perubahan jam OS.
          State.timeSyncSource = State.timeSynced ? 'server-stale' : 'device-untrusted';
          return this.now();
        })();

        this._syncPromise = run;
        try {
          return await run;
        } finally {
          if (this._syncPromise === run) {
            this._syncPromise = null;
          }
        }
      },
      isTrusted() { return State.timeSynced === true && Number.isFinite(State.timeAnchorServerMs) && Number.isFinite(State.timeAnchorPerfMs); },
      now() {
        if (this.isTrusted()) {
          const elapsed = Math.max(0, performance.now() - State.timeAnchorPerfMs);
          return new Date(State.timeAnchorServerMs + elapsed);
        }
        return new Date(Date.now() + State.serverOffsetMs);
      },
      parts(date = this.now(), locale = 'en-US', options = {}) {
        return new Intl.DateTimeFormat(locale, { timeZone: this.zone, ...options }).formatToParts(date);
      },
      dayName(date = this.now()) {
        return new Intl.DateTimeFormat('id-ID', { timeZone: this.zone, weekday:'long' }).format(date);
      },
      dateKey(date = this.now()) {
        const parts = this.parts(date, 'en-US', { year:'numeric', month:'2-digit', day:'2-digit' });
        const y = parts.find(p => p.type === 'year')?.value;
        const m = parts.find(p => p.type === 'month')?.value;
        const d = parts.find(p => p.type === 'day')?.value;
        return `${y}${m}${d}`;
      },
      dateText() {
        return new Intl.DateTimeFormat('id-ID', { timeZone: this.zone, weekday:'long', year:'numeric', month:'long', day:'numeric' }).format(this.now());
      },
      clockText() {
        return new Intl.DateTimeFormat('id-ID', { timeZone: this.zone, hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(this.now());
      },
      iso(date = this.now()) { return date.toISOString(); },
      syncStatusText() {
        if (this.isTrusted() && State.timeSyncSource === 'server') return 'Waktu tersinkron ke server Jakarta.';
        if (this.isTrusted()) return 'Waktu server tersimpan; sinkronisasi terbaru gagal.';
        return 'Waktu server belum tervalidasi.';
      }
    };

    /* =========================================================
       LOCAL STORAGE — semua akses dibungkus agar quota/privacy error tidak crash
       ========================================================= */
    const Local = {
      get(key, fallback = null) {
        try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
      },
      set(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
      },
      remove(key) {
        try { localStorage.removeItem(key); } catch (_) {}
      },
      sessionGet(key, fallback = null) {
        try { return sessionStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
      },
      sessionSet(key, value) {
        try { sessionStorage.setItem(key, value); return true; } catch (_) { return false; }
      },
      sessionRemove(key) {
        try { sessionStorage.removeItem(key); } catch (_) {}
      },
      getJSON(key, fallback = null) { return Util.safeJsonParse(this.get(key), fallback); },
      setJSON(key, value) {
        try {
          return this.set(key, JSON.stringify(value));
        } catch (_) {
          return false;
        }
      },
      clearAppData() {
        let ok = true;

        for (const key of [
          STORAGE.config,
          STORAGE.reports,
          STORAGE.draft,
          STORAGE.perfMode,
          STORAGE.deletedReports,
          'piket_ui_brightness_v1',
          'piket_motion_intensity_v1',
          STORAGE.announcerEnabled,
          STORAGE.announcerAttendancePrefix
        ]) {
          try {
            localStorage.removeItem(key);
          } catch (_) {
            ok = false;
          }
        }

        try {
          Object.keys(localStorage)
            .filter(k => k.startsWith(STORAGE.submittedPrefix))
            .forEach(k => localStorage.removeItem(k));
        } catch (_) {
          ok = false;
        }

        try {
          Object.keys(sessionStorage)
            .filter(k => k.startsWith(STORAGE.submittedPrefix))
            .forEach(k => sessionStorage.removeItem(k));
        } catch (_) {
          ok = false;
        }

        return ok;
      }
    };

    /* =========================================================
       CONFIG / ANGGOTA
       ========================================================= */
    const disposeSupabaseClient = client => {
      try {
        client?.auth?.dispose?.();
      } catch (_) {}
    };

    const Config = {
      isUnsafeSupabaseKey(value) {
        const key = String(value || '').trim();
        if (!key) return false;

        // Supabase secret key generasi baru.
        if (/^sb_secret_/i.test(key)) return true;

        // Legacy service_role key berbentuk JWT.
        const parts = key.split('.');
        if (parts.length !== 3) return false;

        try {
          const payload = parts[1]
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
          const decoded = JSON.parse(atob(payload));
          return decoded?.role === 'service_role';
        } catch (_) {
          return false;
        }
      },
      defaultMembers() {
        return { Senin: [], Selasa: [], Rabu: [], Kamis: [], Jumat: [] };
      },
      normalizeMemberList(value) {
        const raw = Array.isArray(value) ? value.join('\n') : String(value || '');
        const seen = new Set();
        return raw.split(/\r?\n|,/)
          .map(s => s.trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .filter(name => {
            const key = name.toLocaleLowerCase('id-ID');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 30);
      },
      normalize(config) {
        const members = this.defaultMembers();
        const incoming = config?.members || config?.students || {};
        DAYS.forEach(day => { members[day] = this.normalizeMemberList(incoming[day]); });
        return {
          classId: String(config?.classId || '').replace(/\s+/g,''),
          teacherName: String(config?.teacherName || '').trim(),
          members,
          supabase: {
            url: String(config?.supabase?.url || '').trim(),
            key: String(config?.supabase?.key || '').trim(),
            bucket: String(config?.supabase?.bucket || 'piket-foto').trim() || 'piket-foto'
          }
        };
      },
      load() {
        const raw = Local.getJSON(STORAGE.config, null);
        const previousClient = State.supabaseClient;

        if (!raw) {
          disposeSupabaseClient(previousClient);
          State.config = null;
          State.supabaseClient = null;
          Cloud.clientConfigKey = '';
          return null;
        }

        const normalized = this.normalize(raw);

        if (this.isUnsafeSupabaseKey(normalized.supabase.key)) {
          // Bersihkan credential privileged yang mungkin tersimpan
          // dari versi aplikasi sebelum guard diterapkan.
          normalized.supabase.key = '';
          Local.setJSON(STORAGE.config, normalized);
        }

        const previousSupabase = State.config?.supabase || {};
        const cloudChanged =
          previousSupabase.url !== normalized.supabase.url ||
          previousSupabase.key !== normalized.supabase.key;

        if (cloudChanged) {
          disposeSupabaseClient(previousClient);
          State.supabaseClient = null;
        }

        State.config = normalized;
        return State.config;
      },
      save(config) {
        const normalized = this.normalize(config);
        if (this.isUnsafeSupabaseKey(normalized.supabase.key)) return false;

        const previousClient = State.supabaseClient;
        const previousSupabase = State.config?.supabase || {};
        const cloudChanged =
          previousSupabase.url !== normalized.supabase.url ||
          previousSupabase.key !== normalized.supabase.key;

        const saved = Local.setJSON(STORAGE.config, normalized);
        if (!saved) return false;

        if (cloudChanged) {
          disposeSupabaseClient(previousClient);
          State.supabaseClient = null;
        }

        State.config = normalized;
        PiketAIFeatures.invalidateAttendanceSnapshot?.();
        return true;
      },
      membersForToday(date = Time.now()) {
        return State.config?.members?.[Time.dayName(date)] || [];
      }
    };

    /* =========================================================
       SUBMITTED LIMIT
       ========================================================= */
    const Limit = {
      key(classId = State.config?.classId, dateKey = Time.dateKey()) {
        return `${STORAGE.submittedPrefix}${classId || 'global'}_${dateKey}`;
      },
      canSubmit(classId = State.config?.classId, dateKey = Time.dateKey()) {
        const key = this.key(classId, dateKey);
        return (
          State.submittedTodayKey !== key &&
          Local.get(key) !== '1' &&
          Local.sessionGet(key) !== '1'
        );
      },
      markSubmitted(
        classId = State.config?.classId,
        dateKey = Time.dateKey()
      ) {
        const key = this.key(classId, dateKey);
        State.submittedTodayKey = key;
        const saved = Local.set(key, '1');
        if (!saved) Local.sessionSet(key, '1');
        return saved;
      },
      clearToday() {
        const key = this.key();
        if (State.submittedTodayKey === key) State.submittedTodayKey = null;
        Local.remove(key);
        Local.sessionRemove(key);
      }
    };

    /* =========================================================
       SUPABASE — optional, tidak pernah menjadi dependency wajib
       ========================================================= */
    const SUPABASE_REQUEST_TIMEOUT_MS = 20000;

    const createTimeoutFetch = (timeoutMs = SUPABASE_REQUEST_TIMEOUT_MS) => {
      return async (input, init = {}) => {
        const controller = new AbortController();
        const upstreamSignal = init.signal;
        const relayAbort = () => controller.abort();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);

        if (upstreamSignal) {
          if (upstreamSignal.aborted) {
            controller.abort();
          } else {
            upstreamSignal.addEventListener('abort', relayAbort, { once:true });
          }
        }

        try {
          return await window.fetch(input, {
            ...init,
            signal: controller.signal
          });
        } finally {
          window.clearTimeout(timer);
          upstreamSignal?.removeEventListener('abort', relayAbort);
        }
      };
    };

    const Cloud = {
      sdkWaitPromise: null,
      clientConfigKey: '',
      ready() {
        return Boolean(State.supabaseClient && State.config?.supabase?.url && State.config?.supabase?.key);
      },
      async waitForSdk(timeoutMs = 12000) {
        if (window.supabase?.createClient) return true;
        if (this.sdkWaitPromise) return this.sdkWaitPromise;

        const script = Util.el('supabase-sdk');
        this.sdkWaitPromise = new Promise(resolve => {
          let settled = false;
          let intervalId = 0;
          let timeoutId = 0;

          const finish = ok => {
            if (settled) return;
            settled = true;
            if (intervalId) window.clearInterval(intervalId);
            if (timeoutId) window.clearTimeout(timeoutId);
            script?.removeEventListener('load', onLoad);
            script?.removeEventListener('error', onError);
            resolve(ok);
          };
          const check = () => finish(Boolean(window.supabase?.createClient));
          const onLoad = () => check();
          const onError = () => finish(false);

          script?.addEventListener('load', onLoad, { once:true });
          script?.addEventListener('error', onError, { once:true });
          intervalId = window.setInterval(check, 50);
          timeoutId = window.setTimeout(() => finish(Boolean(window.supabase?.createClient)), timeoutMs);
          check();
        }).finally(() => {
          this.sdkWaitPromise = null;
        });

        return this.sdkWaitPromise;
      },
      async buildClient() {
        const cfg = State.config?.supabase;
        if (!cfg?.url || !cfg?.key) {
          disposeSupabaseClient(State.supabaseClient);
          State.supabaseClient = null;
          this.clientConfigKey = '';
          return null;
        }

        const configKey = `${cfg.url}\n${cfg.key}`;
        if (State.supabaseClient?.auth && this.clientConfigKey === configKey) {
          return State.supabaseClient;
        }

        const sdkReady = await this.waitForSdk();
        if (!sdkReady || !window.supabase?.createClient) return null;

        disposeSupabaseClient(State.supabaseClient);
        State.supabaseClient = null;
        this.clientConfigKey = '';

        try {
          State.supabaseClient = window.supabase.createClient(cfg.url, cfg.key, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
            global: { fetch: createTimeoutFetch() }
          });
          this.clientConfigKey = configKey;
          return State.supabaseClient;
        } catch (error) {
          State.supabaseClient = null;
          console.warn('Cloud.buildClient:', error);
          return null;
        }
      },
      async test(config = State.config) {
        const cfg = config?.supabase;
        if (!cfg?.url || !cfg?.key) {
          return { ok:false, message:'Supabase belum siap atau URL/key belum valid.' };
        }
        if (Config.isUnsafeSupabaseKey(cfg.key)) {
          return {
            ok:false,
            message:'Secret/Service Role Key tidak boleh digunakan di browser.'
          };
        }
        if (!window.supabase?.createClient) {
          return { ok:false, message:'Supabase SDK belum siap.' };
        }

        let client = null;
        try {
          client = window.supabase.createClient(cfg.url, cfg.key, {
            auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false },
            global: { fetch: createTimeoutFetch() }
          });
          const { error } = await client.from('piket_reports').select('id').limit(1);
          if (error) {
            const text = String(error?.message || '').toLowerCase();
            const isRlsOnly =
              error?.code === '42501' ||
              /row-level security|permission denied|not authorized/i.test(text);
            if (isRlsOnly) {
              return {
                ok:false,
                message:'Supabase terhubung, tetapi RLS menolak akses anonim. Versi aplikasi ini tidak memiliki login guru; izinkan akses anonim sesuai policy yang aman, atau tambahkan autentikasi di backend.'
              };
            }
            return { ok:false, message:error.message };
          }
          return { ok:true, message:'Koneksi Supabase berhasil.' };
        } catch (error) {
          return { ok:false, message:error?.message || 'Koneksi gagal.' };
        } finally {
          disposeSupabaseClient(client);
        }
      },
      canonicalOrigin(value) {
        try {
          const parsed = new URL(String(value || '').trim());
          if (parsed.protocol !== 'https:') return null;
          return parsed.origin;
        } catch (_) {
          return null;
        }
      },
      reportMatchesContext(report, context = null) {
        // Non-local cached reports must be proven to belong to the currently
        // configured Supabase project before they can be rendered or reused.
        if (report?.local_only === true) return true;
        if (!context) return true;

        const currentOrigin = this.canonicalOrigin(context.url);
        if (!currentOrigin) return false;

        const rawOrigin = String(report?._cloudOrigin || '').trim();
        if (rawOrigin) {
          const reportOrigin = this.canonicalOrigin(rawOrigin);
          if (!reportOrigin || reportOrigin !== currentOrigin) return false;
        }

        const reportBucket = String(report?._cloudBucket || '').trim();
        if (reportBucket && reportBucket !== String(context.bucket || '')) {
          return false;
        }

        // Legacy cached rows may not have explicit provenance. Their photo
        // URLs can still prove the originating Supabase project.
        if (!rawOrigin) {
          const legacyOrigins = [
            report?.photo_anggota_url,
            report?.photo_kondisi_url
          ]
            .filter(Boolean)
            .map(url => {
              try { return new URL(String(url)).origin; } catch (_) { return ''; }
            })
            .filter(Boolean);

          if (legacyOrigins.length) {
            return legacyOrigins.every(origin => origin === currentOrigin);
          }

          // Without provenance there is no safe way to distinguish a row from
          // a previously configured backend when the class ID is reused.
          return false;
        }

        return true;
      },
      captureContext() {
        const cfg = State.config?.supabase;
        const client = State.supabaseClient;
        const url = this.canonicalOrigin(cfg?.url);

        if (!client || !url || !cfg?.key || !cfg?.bucket) {
          return null;
        }

        return {
          client,
          url,
          bucket: String(cfg.bucket)
        };
      },
      async uploadPhoto(
        blob,
        folder,
        label,
        dateKey = Time.dateKey(),
        classId = State.config?.classId,
        context = null
      ) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        const bucket = ctx?.bucket;

        if (!client || !bucket) {
          return {
            ok:false,
            skipped:true,
            url:null,
            path:null
          };
        }

        const safeClass = String(classId || 'global')
          .replace(/[^a-zA-Z0-9_-]/g,'_');
        const safeDate = String(dateKey || Time.dateKey())
          .replace(/[^0-9]/g,'');
        const nonce = window.crypto?.randomUUID
          ? window.crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
        const path =
          `${safeClass}/${safeDate}/${folder}_${nonce}.jpg`;
        let uploadAttempted = false;

        try {
          const storage = client.storage.from(bucket);
          uploadAttempted = true;
          const { error } = await storage.upload(path, blob, {
            upsert:false,
            contentType:blob?.type || 'image/jpeg',
            cacheControl:'3600'
          });
          if (error) throw error;

          return { ok:true, url:null, path };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            url:null,
            // An HTTP/network response can be ambiguous after the upload request
            // reaches Storage. Preserve the deterministic path so callers can
            // issue a safe cleanup attempt instead of leaking an orphan object.
            path:uploadAttempted ? path : null,
            message:`${label}: ${error?.message || 'upload gagal'}`
          };
        }
      },
      async createReport(report, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        if (!client) return { ok:false, skipped:true };

        try {
          const {
            time_source,
            time_sync_source,
            _cloudOrigin,
            _cloudBucket,
            photo_anggota_url,
            photo_kondisi_url,
            photo_anggota_path,
            photo_kondisi_path,
            ...row
          } = report || {};

          const photoFields = {
            photo_anggota_path:
              String(photo_anggota_path || '').trim() ||
              this.extractStoragePath(photo_anggota_url, ctx),
            photo_kondisi_path:
              String(photo_kondisi_path || '').trim() ||
              this.extractStoragePath(photo_kondisi_url, ctx)
          };

          if (!photoFields.photo_anggota_path || !photoFields.photo_kondisi_path) {
            throw new Error('Path foto cloud tidak lengkap. Upload laporan dihentikan untuk menjaga evidence.');
          }

          const { error } = await client
            .from('piket_reports')
            .insert({ ...row, ...photoFields, deleted_at:null });
          if (error) throw error;
          return { ok:true };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            message:error?.message || 'Gagal menyimpan laporan ke Supabase.'
          };
        }
      },
      async repairReport(report, photoAnggotaPath, photoKondisiPath, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        const id = String(report?.id || '').trim();
        const anggotaPath = String(photoAnggotaPath || '').trim();
        const kondisiPath = String(photoKondisiPath || '').trim();
        if (!client || !id || !anggotaPath || !kondisiPath) {
          return { ok:false, skipped:!client, message:'Data perbaikan laporan cloud tidak lengkap.' };
        }

        try {
          const {
            id: _id,
            time_source,
            time_sync_source,
            _cloudOrigin,
            _cloudBucket,
            photo_anggota_url,
            photo_kondisi_url,
            photo_anggota_path,
            photo_kondisi_path,
            ...row
          } = report || {};

          const { error } = await client
            .from('piket_reports')
            .update({
              ...row,
              photo_anggota_path: anggotaPath,
              photo_kondisi_path: kondisiPath,
              local_only: false,
              deleted_at: null
            })
            .eq('id', id);
          if (error) throw error;
          return { ok:true };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            message:error?.message || 'Gagal memperbaiki laporan parsial di Supabase.'
          };
        }
      },
      photoPath(report, kind, context = null) {
        const ctx = context || this.captureContext();

        // A Storage path is not globally unique. Prevent an old report from
        // being resolved against a newly configured Supabase project/bucket.
        if (ctx) {
          const rawOrigin = String(report?._cloudOrigin || '').trim();
          if (rawOrigin) {
            const reportOrigin = this.canonicalOrigin(rawOrigin);
            if (!reportOrigin || reportOrigin !== ctx.url) return null;
          }

          const reportBucket = String(report?._cloudBucket || '').trim();
          if (reportBucket && reportBucket !== ctx.bucket) return null;
        }

        const safeKind = kind === 'kondisi' ? 'kondisi' : 'anggota';
        const pathKey = `photo_${safeKind}_path`;
        const urlKey = `photo_${safeKind}_url`;
        const explicitPath = String(report?.[pathKey] || '').trim();
        if (explicitPath) return explicitPath;

        const legacyUrl = String(report?.[urlKey] || '').trim();
        return legacyUrl ? this.extractStoragePath(legacyUrl, ctx) : null;
      },
      async createSignedPhotoUrl(path, expiresIn = 300, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        const bucket = ctx?.bucket;
        const cleanPath = String(path || '').trim();
        if (!client || !bucket || !cleanPath) return '';

        try {
          const { data, error } = await client.storage
            .from(bucket)
            .createSignedUrl(cleanPath, expiresIn);
          if (error) throw error;
          return data?.signedUrl || '';
        } catch (error) {
          console.warn('createSignedPhotoUrl:', error);
          return '';
        }
      },
      normalizedPhotoFields(report, context = null) {
        const ctx = context || this.captureContext();
        return {
          photo_anggota_path: this.photoPath(report, 'anggota', ctx),
          photo_kondisi_path: this.photoPath(report, 'kondisi', ctx)
        };
      },
            extractStoragePath(url, context = null) {
        const ctx = context || this.captureContext();
        const bucket = ctx?.bucket;
        const projectUrlText = ctx?.url;
        if (!url || !bucket || !projectUrlText) return null;

        try {
          const parsed = new URL(String(url));
          if (!/^https?:$/i.test(parsed.protocol)) return null;

          const projectUrl = new URL(projectUrlText);
          if (parsed.origin !== projectUrl.origin) return null;

          const encodedBucket = encodeURIComponent(bucket);
          const markers = [
            `/storage/v1/object/public/${encodedBucket}/`,
            `/storage/v1/object/public/${bucket}/`,
            `/public/${encodedBucket}/`,
            `/public/${bucket}/`
          ];
          const pathname = parsed.pathname;
          const marker = markers.find(item => pathname.startsWith(item));
          if (!marker) return null;

          const rawPath = pathname.slice(marker.length);
          return rawPath ? decodeURIComponent(rawPath) : null;
        } catch (_) {
          return null;
        }
      },
      async storageObjectExists(path, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        const bucket = ctx?.bucket;
        const cleanPath = String(path || '').trim();
        if (!client || !bucket || !cleanPath) return false;

        try {
          const storage = client.storage.from(bucket);
          if (typeof storage.exists !== 'function') return false;

          const { data, error } = await storage.exists(cleanPath);
          return error == null && data === true;
        } catch (_) {
          return false;
        }
      },
      async hasCompleteEvidence(report, context = null) {
        const ctx = context || this.captureContext();
        const anggotaPath = this.photoPath(report, 'anggota', ctx);
        const kondisiPath = this.photoPath(report, 'kondisi', ctx);
        if (!anggotaPath || !kondisiPath) return false;

        const [anggotaExists, kondisiExists] = await Promise.all([
          this.storageObjectExists(anggotaPath, ctx),
          this.storageObjectExists(kondisiPath, ctx)
        ]);
        return anggotaExists === true && kondisiExists === true;
      },
      async deleteStoragePaths(paths, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        const bucket = ctx?.bucket;
        if (!client || !bucket) {
          return {
            ok:false,
            skipped:true,
            removed:0,
            message:'Cloud belum siap.'
          };
        }

        const unique = [
          ...new Set(
            (Array.isArray(paths) ? paths : [])
              .filter(Boolean)
              .map(String)
          )
        ];
        if (!unique.length) return { ok:true, skipped:false, removed:0 };

        try {
          const { error } = await client.storage
            .from(bucket)
            .remove(unique);
          if (error) throw error;
          return { ok:true, skipped:false, removed:unique.length };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            removed:0,
            message:error?.message || 'Gagal menghapus foto dari Supabase Storage.'
          };
        }
      },
      async cleanupReportPhotos(report, context = null) {
        const ctx = context || this.captureContext();
        const paths = [
          this.photoPath(report, 'anggota', ctx),
          this.photoPath(report, 'kondisi', ctx)
        ].filter(Boolean);
        const expected = [
          report?.photo_anggota_path || report?.photo_anggota_url,
          report?.photo_kondisi_path || report?.photo_kondisi_url
        ].filter(Boolean);

        if (paths.length !== expected.length) {
          return {
            ok:false,
            skipped:false,
            removed:0,
            message:'Bucket/path foto laporan tidak cocok dengan konfigurasi saat ini. Penghapusan ditunda agar foto tidak menjadi orphan.'
          };
        }

        return this.deleteStoragePaths(paths, ctx);
      },
      async readReportById(id, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        if (!client) return { ok:false, skipped:true, data:null };

        try {
          const { data, error } = await client.from('piket_reports')
            .select('id,photo_anggota_path,photo_kondisi_path,photo_anggota_url,photo_kondisi_url,local_only,date_key,deleted_at,class_id')
            .eq('id', id)
            .maybeSingle();
          if (error) throw error;
          return { ok:true, data:data || null };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            data:null,
            message:error?.message || 'Gagal membaca laporan cloud.'
          };
        }
      },
      async deleteReport(id, report = null, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        if (!client) {
          return {
            ok:false,
            skipped:true,
            message:'Cloud belum siap.'
          };
        }

        let target = report;
        let lookup = null;

        try {
          if (!target) {
            lookup = await this.readReportById(id, ctx);
            if (!lookup.ok) {
              return {
                ok:false,
                skipped:false,
                message:lookup.message || 'Metadata laporan cloud tidak dapat dibaca.'
              };
            }
            target = lookup.data;
          }

          if (!target) {
            return { ok:true, softDeleted:true, storageOk:true, alreadyGone:true };
          }

          // Soft delete lebih dulu menjaga konsistensi DB + Storage.
          // Jika cleanup foto gagal, row tetap bertanda deleted_at dan dapat
          // dibersihkan ulang oleh worker/manual retry tanpa kehilangan record.
          if (!target.deleted_at) {
            const { data: rows, error } = await client
              .from('piket_reports')
              .update({ deleted_at:new Date().toISOString() })
              .eq('id', id)
              .is('deleted_at', null)
              .select('id,deleted_at');
            if (error) throw error;
            if (!rows?.length) {
              const verify = await this.readReportById(id, ctx);
              if (verify.ok && !verify.data) {
                return { ok:true, softDeleted:true, storageOk:true, alreadyGone:true };
              }
              target = verify.data || target;
            }
          }

          const storageCleanup = await this.cleanupReportPhotos(target, ctx);
          if (!storageCleanup.ok) {
            return {
              ok:false,
              softDeleted:true,
              storageOk:false,
              storageMessage:storageCleanup.message,
              message:`Laporan sudah ditandai terhapus, tetapi foto belum dibersihkan: ${storageCleanup.message || 'error'}`
            };
          }

          return { ok:true, softDeleted:true, storageOk:true, storageMessage:'' };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            softDeleted:Boolean(target?.deleted_at),
            storageOk:false,
            message:error?.message || 'Gagal menandai laporan terhapus di cloud.'
          };
        }
      },
      async readReports(classId = State.config?.classId, context = null) {
        const ctx = context || this.captureContext();
        const client = ctx?.client;
        if (!client) return { ok:false, skipped:true, data:[] };

        try {
          const snapshotClassId = String(classId || '');
          const { data, error } = await client
            .from('piket_reports')
            .select('id,day,created_at,absents,present_count,total_members,local_only,photo_anggota_path,photo_kondisi_path,photo_anggota_url,photo_kondisi_url,date_key,class_id,deleted_at')
            .eq('class_id', snapshotClassId)
            .is('deleted_at', null)
            .order('created_at', { ascending:false })
            .limit(50);
          if (error) throw error;
          return { ok:true, data:Array.isArray(data) ? data : [] };
        } catch (error) {
          return {
            ok:false,
            skipped:false,
            data:[],
            message:error?.message || 'Gagal membaca laporan.'
          };
        }
      }
    };;

    /* =========================================================
       IMAGE PIPELINE — kompres sesuai kemampuan device
       ========================================================= */
    const ImagePipeline = {
      dataUrlToBlob(dataUrl) {
        const [header, base64] = String(dataUrl || '').split(',', 2);
        if (!header || !base64) throw new Error('Screenshot DeepAR tidak valid.');
        const mime = /data:(.*?);base64/i.exec(header)?.[1] || 'image/png';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type:mime });
      },
      async videoToBlob(video) {
        const settings = Performance.imageSettings();
        const track = State.camStream?.getVideoTracks?.()[0];

        if (
          !track ||
          track.readyState !== 'live' ||
          !video ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.paused
        ) {
          throw new Error('Kamera belum siap atau koneksi kamera terputus. Tekan Coba lagi.');
        }

        const sourceW = video.videoWidth;
        const sourceH = video.videoHeight;
        if (!sourceW || !sourceH) throw new Error('Kamera belum siap. Tunggu preview muncul.');

        const targetAspect = State.photoTarget === 'kondisi' ? (16 / 9) : (9 / 16);
        const sourceAspect = sourceW / sourceH;

        let sx = 0;
        let sy = 0;
        let sw = sourceW;
        let sh = sourceH;
        if (sourceAspect > targetAspect) {
          sw = Math.round(sourceH * targetAspect);
          sx = Math.round((sourceW - sw) / 2);
        } else if (sourceAspect < targetAspect) {
          sh = Math.round(sourceW / targetAspect);
          sy = Math.round((sourceH - sh) / 2);
        }

        const width = Math.max(1, Math.min(settings.maxWidth, sw));
        const height = Math.max(1, Math.round(width / targetAspect));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha:false, desynchronized:true });
        if (!ctx) throw new Error('Canvas tidak tersedia di browser ini.');
        if (State.camFacingMode === 'user') {
          ctx.translate(width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob(value => value ? resolve(value) : reject(new Error('Gagal membuat file foto.')), 'image/jpeg', settings.quality);
        });
        return blob;
      }
    };

    /* =========================================================
       CAMERA — safe start/stop/retry/facing switch
       ========================================================= */
    /* =========================================================
       AI FACE DETECTION — local/on-device gate for member photo
       Tidak melakukan face recognition/identifikasi seseorang.
       ========================================================= */
    /* =========================================================
       AI FACE DETECTION — HUMAN.JS, local/on-device member-photo gate
       Engine: @vladmandic/human@3.3.6
       Catatan: detector hanya mencari keberadaan wajah; tidak mengenali
       identitas seseorang dan tidak mengirim frame kamera ke server.
       ========================================================= */
    const FEATURE_AI_FACE_DETECTOR_ENABLED = true;
    const HUMAN_MAX_FACES = 8;
    const HUMAN_MODEL_LOAD_TIMEOUT_MS = 15000;

    const FaceDetection = {
      module: null,
      detector: null,
      loadingPromise: null,
      filesetResolver: null,
      imageDetector: null,
      imageLoadingPromise: null,
      _gen: 0,
      _imageLoadSeq: 0,
      _loadSeq: 0,
      _processing: false,
      _degraded: false,
      _backendIndex: 0,
      _lastBadgeAnnounceKey: '',
      _lastBadgeAnnounceAt: 0,
      _badgeTimer: 0,
      _humanLibraryPromise: null,
      rafId: 0,
      active: false,
      lastVideoTime: -1,
      stableHits: 0,
      lastCount: 0,
      lastDetectPerfMs: 0,
      lastDetectDurationMs: 0,
      runtimeEmaMs: 0,
      runtimeSamples: 0,
      nextDetectAt: 0,
      detectIntervalMs: 140,
      modelUrl: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.js',
      modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/',
      wasmPath: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/',
      backendOrder: ['webgl', 'wasm', 'cpu'],
      previewConfig: {
        face: {
          enabled: true,
          detector: {
            enabled: true,
            rotation: false,
            return: false,
            mask: false,
            maxDetected: HUMAN_MAX_FACES,
            minConfidence: 0.25,
            minSize: 50,
            iouThreshold: 0.1,
            scale: 1,
            square: false
          },
          mesh: { enabled: false },
          iris: { enabled: false },
          description: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
          attention: { enabled: false }
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false }
      },
      backendConfig(backend = 'webgl') {
        return {
          backend,
          wasmPath: this.wasmPath,
          modelBasePath: this.modelBasePath,
          debug: false,
          async: true,
          warmup: 'none',
          cacheModels: true,
          cacheSensitivity: 0.01,
          validateModels: true,
          filter: { enabled: false },
          face: {
            enabled: true,
            modelPath: 'blazeface-back.json',
            detector: {
              enabled: true,
              rotation: false,
              return: false,
              mask: false,
              maxDetected: HUMAN_MAX_FACES,
              minConfidence: 0.25,
              minSize: 50,
              iouThreshold: 0.1,
              scale: 1,
              square: false
            },
            mesh: { enabled: false },
            iris: { enabled: false },
            description: { enabled: false },
            emotion: { enabled: false },
            antispoof: { enabled: false },
            liveness: { enabled: false },
            attention: { enabled: false }
          },
          body: { enabled: false },
          hand: { enabled: false },
          object: { enabled: false },
          gesture: { enabled: false },
          segmentation: { enabled: false }
        };
      },
      profileConfig() {
        const profile = Performance.aiProfile();
        this.detectIntervalMs = profile.interval;
        this.previewConfig.face.detector.maxDetected = HUMAN_MAX_FACES;
        this.previewConfig.face.detector.minConfidence = profile.confidence;
        this.previewConfig.face.detector.minSize = profile.minSize;
        this.previewConfig.face.detector.scale = profile.scale;
        return profile;
      },
      adaptiveInterval() {
        // Inferensi multi-wajah lebih mahal. Penalti bertambah berdasarkan jumlah wajah
        // dan runtime nyata agar perangkat lemah tidak terus-menerus penuh CPU/GPU.
        const count = Math.min(Math.max(0, Number(this.lastCount) || 0), HUMAN_MAX_FACES);
        const groupPenalty = count >= 8 ? 120 : count >= 6 ? 90 : count >= 4 ? 60 : count >= 2 ? 30 : 0;
        const ema = Number(this.runtimeEmaMs || 0);
        const runtimePenalty = ema > 650
          ? Math.min(180, Math.round((ema - 650) * 0.28))
          : 0;
        const slowPenalty = this.lastDetectDurationMs > this.detectIntervalMs
          ? Math.min(140, Math.round((this.lastDetectDurationMs - this.detectIntervalMs) * 0.40))
          : 0;
        return Math.min(520, this.detectIntervalMs + groupPenalty + runtimePenalty + slowPenalty);
      },
      getHumanCtor() {
        const root = window.Human;
        if (typeof root?.Human === 'function') return root.Human;
        if (typeof root === 'function') return root;
        if (typeof root?.default?.Human === 'function') return root.default.Human;
        if (typeof root?.default === 'function') return root.default;
        return null;
      },
      async loadHumanLibrary() {
        const existingCtor = this.getHumanCtor();
        if (existingCtor) return existingCtor;
        if (this._humanLibraryPromise) return this._humanLibraryPromise;

        const timeoutMs = 12000;
        const loadOne = (src) => new Promise((resolve, reject) => {
          let settled = false;
          const script = document.createElement('script');
          const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            script.remove();
            reject(new Error(`Timeout memuat Human.js: ${src}`));
          }, timeoutMs);

          const cleanup = () => {
            window.clearTimeout(timer);
            script.onload = null;
            script.onerror = null;
          };

          script.async = true;
          script.crossOrigin = 'anonymous';
          script.src = src;
          script.onload = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const ctor = this.getHumanCtor();
            if (!ctor) {
              reject(new Error('Human.js termuat tetapi konstruktor Human tidak ditemukan.'));
              return;
            }
            resolve(ctor);
          };
          script.onerror = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`Gagal memuat Human.js dari CDN: ${src}`));
          };
          document.head.appendChild(script);
        });

        const promise = loadOne(this.modelUrl);

        this._humanLibraryPromise = promise;
        try {
          return await promise;
        } catch (error) {
          this._humanLibraryPromise = null;
          throw error;
        }
      },
      async _createEngine(backend) {
        const HumanCtor = await this.loadHumanLibrary();
        const engine = new HumanCtor(this.backendConfig(backend));
        let loadTask = null;

        try {
          // Jangan warmup penuh: detector saja akan dimuat on-demand dan lebih
          // ringan untuk perangkat kelas/HP. Human mendukung warmup 'none'.
          loadTask = engine.load();
          let timer = 0;
          try {
            await Promise.race([
              loadTask,
              new Promise((_, reject) => {
                timer = window.setTimeout(() => {
                  const timeoutError = new Error('Pemuatan model Human.js melewati batas waktu.');
                  timeoutError.code = 'HUMAN_MODEL_TIMEOUT';
                  reject(timeoutError);
                }, HUMAN_MODEL_LOAD_TIMEOUT_MS);
              })
            ]);
          } finally {
            if (timer) window.clearTimeout(timer);
          }

          const validation = typeof engine.validate === 'function'
            ? engine.validate(this.previewConfig)
            : [];
          if (Array.isArray(validation) && validation.length) {
            console.warn('Human.js config validation:', validation);
          }

          return engine;
        } catch (error) {
          // Timeout tidak langsung mereset engine karena loadTask masih mungkin
          // sedang berjalan. Reset dilakukan setelah promise tersebut selesai.
          const cleanup = () => {
            try { engine.models?.reset?.(); } catch (resetError) {
              console.warn('Cleanup model Human.js kandidat gagal:', resetError);
            }
          };

          if (error?.code === 'HUMAN_MODEL_TIMEOUT' && loadTask) {
            Promise.resolve(loadTask).then(cleanup, cleanup).catch(() => {});
          } else {
            cleanup();
          }

          throw error;
        }
      },
      async load({ preferBackend = null } = {}) {
        if (this.detector) return this.detector;
        if (this.loadingPromise) return this.loadingPromise;

        const loadSeq = ++this._loadSeq;
        const task = (async () => {
          const preferred = preferBackend || this.backendOrder[this._backendIndex] || 'webgl';
          const ordered = [
            preferred,
            ...this.backendOrder.filter(item => item !== preferred)
          ];
          let lastError = null;

          for (let i = 0; i < ordered.length; i++) {
            const backend = ordered[i];
            if (loadSeq !== this._loadSeq) throw new Error('Inisialisasi Human.js sudah dibatalkan.');

            try {
              console.info(`FaceDetection: mencoba Human.js backend=${backend}`);
              const engine = await this._createEngine(backend);
              if (loadSeq !== this._loadSeq) {
                try { engine.models?.reset?.(); } catch (_) {}
                throw new Error('Inisialisasi Human.js menjadi obsolete.');
              }

              this._backendIndex = this.backendOrder.indexOf(backend);
              this.module = window.Human || this.module;
              this.detector = engine;
              this.imageDetector = engine;
              this._degraded = false;
              console.info(`FaceDetection: Human.js siap, backend=${backend}, version=${engine.version || 'unknown'}`);
              return engine;
            } catch (error) {
              lastError = error;
              console.warn(`FaceDetection: backend=${backend} gagal`, error);

              const message = `${error?.name || ''} ${error?.message || ''}`;
              if (/gagal memuat human\.js|timeout memuat human\.js|konstruktor human tidak ditemukan|human\.js/i.test(message)) {
                // Jika engine utama tidak berhasil dimuat, mengganti backend
                // tidak akan membantu dan hanya memperlama fallback.
                break;
              }
            }
          }

          const finalError = lastError || new Error('Human.js gagal diinisialisasi.');
          throw finalError;
        })();

        this.loadingPromise = task;
        try {
          return await task;
        } catch (error) {
          if (this.loadingPromise === task) this.loadingPromise = null;
          throw error;
        } finally {
          if (this.loadingPromise === task) this.loadingPromise = null;
        }
      },
      async loadImageDetector() {
        // Human memakai engine yang sama untuk input video maupun gambar.
        // Metode dipertahankan agar kontrak lama tetap kompatibel.
        const engine = await this.load();
        this.imageDetector = engine;
        return engine;
      },
      badge(text, state='') {
        const el = Util.el('face-detection-badge');
        if (!el) return;

        const announceable = state === 'ready' || state === 'error';
        const key = announceable ? `${state}|${text}` : '';
        const now = performance.now();
        const shouldAnnounce =
          announceable &&
          (
            key !== this._lastBadgeAnnounceKey ||
            now - (this._lastBadgeAnnounceAt || 0) >= 2500
          );

        el.setAttribute('aria-live', shouldAnnounce ? 'polite' : 'off');
        el.setAttribute('aria-atomic', 'true');
        el.textContent = text;
        el.classList.remove('ready','warning','error');
        if (state) el.classList.add(state);

        if (shouldAnnounce) {
          this._lastBadgeAnnounceKey = key;
          this._lastBadgeAnnounceAt = now;
          if (this._badgeTimer) window.clearTimeout(this._badgeTimer);
          this._badgeTimer = window.setTimeout(() => {
            if (el.isConnected && el.getAttribute('aria-live') === 'polite') {
              el.setAttribute('aria-live', 'off');
            }
            this._badgeTimer = 0;
          }, 120);
        }
      },
      clearOverlay() {
        const canvas = Util.el('face-detection-overlay');
        const video = Util.el('camera-stream');
        if (!canvas || !video) return;
        const rect = video.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w; canvas.height = h;
        }
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      },
      draw(detections, video) {
        const canvas = Util.el('face-detection-overlay');
        if (!canvas || !video) return;

        const rect = video.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);

        const sourceW = Math.max(1, video.videoWidth);
        const sourceH = Math.max(1, video.videoHeight);
        const targetAspect = rect.width / Math.max(1, rect.height);
        const sourceAspect = sourceW / sourceH;

        let sx = 0;
        let sy = 0;
        let sw = sourceW;
        let sh = sourceH;

        if (sourceAspect > targetAspect) {
          sw = sourceH * targetAspect;
          sx = (sourceW - sw) / 2;
        } else if (sourceAspect < targetAspect) {
          sh = sourceW / targetAspect;
          sy = (sourceH - sh) / 2;
        }

        const scaleX = width / sw;
        const scaleY = height / sh;
        const mirrored =
          String(video.style.transform || '').includes('scaleX(-1)') ||
          State.camFacingMode === 'user';

        ctx.lineWidth = Math.max(2, 2.5 * dpr);
        ctx.strokeStyle = '#34d399';
        ctx.fillStyle = 'rgba(52,211,153,.12)';

        for (const detection of detections || []) {
          const b = detection?.box || detection?.boundingBox;
          if (!b) continue;

          const bx = Array.isArray(b)
            ? Number(b[0])
            : Number(b.originX);
          const by = Array.isArray(b)
            ? Number(b[1])
            : Number(b.originY);
          const bw = Array.isArray(b)
            ? Number(b[2])
            : Number(b.width);
          const bh = Array.isArray(b)
            ? Number(b[3])
            : Number(b.height);

          if (![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) continue;

          let x = (bx - sx) * scaleX;
          const y = (by - sy) * scaleY;
          const w = bw * scaleX;
          const h = bh * scaleY;

          if (mirrored) x = width - x - w;

          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
        }
      },
      _resultFaces(result) {
        return Array.isArray(result?.face)
          ? result.face.filter(Boolean).slice(0, HUMAN_MAX_FACES)
          : [];
      },
      async _detect(input, config = this.previewConfig) {
        const engine = await this.load();
        return await engine.detect(input, config);
      },
      async _recover(error) {
        if (this._backendIndex >= this.backendOrder.length - 1) return false;
        if (!/webgl|context.?lost|backend|shader|tfjs/i.test(`${error?.name || ''} ${error?.message || ''}`)) return false;

        const nextIndex = this._backendIndex + 1;
        const nextBackend = this.backendOrder[nextIndex];
        if (!nextBackend) return false;

        console.warn(`FaceDetection: runtime recovery, pindah backend=${nextBackend}`, error);
        this.disposeEngineOnly();
        this._backendIndex = nextIndex;
        try {
          await this.load({ preferBackend: nextBackend });
          return true;
        } catch (recoveryError) {
          console.warn('FaceDetection runtime recovery gagal:', recoveryError);
          this._degraded = true;
          return false;
        }
      },
      async start(video) {
        this.stop();
        const gen = ++this._gen;

        if (State.photoTarget !== 'anggota' || !video || !State.camStream) {
          this.badge('AI wajah: tidak diperlukan', '');
          return;
        }

        this.profileConfig();
        if (!FEATURE_AI_FACE_DETECTOR_ENABLED) {
          this._degraded = true;
          State.faceDetectorLoading = false;
          State.faceDetectionActive = false;
          this.active = false;
          this.badge('AI wajah: dimatikan · mode manual', 'warning');
          return;
        }

        this._degraded = false;
        State.faceDetectorLoading = true;
        State.faceDetectionActive = true;
        State.faceDetectionStable = 0;
        State.faceDetectionCount = 0;
        this.stableHits = 0;
        this.lastCount = 0;
        this.lastVideoTime = -1;
        this.lastDetectPerfMs = 0;
        this.lastDetectDurationMs = 0;
        this.runtimeEmaMs = 0;
        this.runtimeSamples = 0;
        this.nextDetectAt = 0;
        this._processing = false;
        this.badge('AI wajah: memuat Human.js…');

        try {
          const detector = await this.load();
          if (gen !== this._gen) return;
          if (State.currentPanel !== 'student' || State.photoTarget !== 'anggota') return;

          this.active = true;
          State.faceDetector = detector;
          State.faceDetectorLoading = false;
          this.badge(`AI wajah: mencari… (${this.backendOrder[this._backendIndex] || 'auto'})`);

          const loop = async (frameNow = performance.now()) => {
            if (
              !this.active ||
              gen !== this._gen ||
              !State.camStream ||
              State.currentPanel !== 'student' ||
              State.photoTarget !== 'anggota'
            ) {
              return;
            }

            try {
              if (
                !this._processing &&
                video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
                video.currentTime !== this.lastVideoTime &&
                frameNow >= this.nextDetectAt
              ) {
                this._processing = true;
                this.lastDetectPerfMs = frameNow;
                this.nextDetectAt = frameNow + this.adaptiveInterval();
                this.lastVideoTime = video.currentTime;

                const startedAt = performance.now();
                const result = await this._detect(video, this.previewConfig);
                const detections = this._resultFaces(result);
                const detectDuration = performance.now() - startedAt;

                this.lastDetectDurationMs = detectDuration;
                this.lastCount = detections.length;
                this.runtimeEmaMs = this.runtimeSamples
                  ? (this.runtimeEmaMs * 0.78 + detectDuration * 0.22)
                  : detectDuration;
                this.runtimeSamples = Math.min(999, this.runtimeSamples + 1);
                this.nextDetectAt = performance.now() + this.adaptiveInterval();
                State.faceDetectionCount = detections.length;
                Performance.adaptFromAiRuntime(detectDuration, detections.length);
                this.profileConfig();

                if (detections.length > 0) {
                  this.stableHits = Math.min(this.stableHits + 1, 6);
                } else {
                  this.stableHits = Math.max(0, this.stableHits - 2);
                }

                State.faceDetectionStable = this.stableHits;
                this.draw(detections, video);

                if (this.stableHits >= 3) {
                  this.badge(`${detections.length} wajah terdeteksi · siap`, 'ready');
                } else {
                  this.badge(
                    detections.length
                      ? 'Wajah terdeteksi · menstabilkan…'
                      : 'AI wajah: wajah belum terdeteksi',
                    'warning'
                  );
                }

                if (
                  Number.isFinite(detectDuration) &&
                  detectDuration > Math.max(this.detectIntervalMs * 2.5, 900)
                ) {
                  console.warn(
                    `FaceDetection lambat: ${detectDuration.toFixed(0)}ms, interval=${this.detectIntervalMs}ms, backend=${this.backendOrder[this._backendIndex] || 'unknown'}`
                  );
                }
              }
            } catch (error) {
              console.warn('Face detection frame gagal:', error);
              const recovered = await this._recover(error);
              if (!recovered) {
                this._degraded = true;
                this.active = false;
                State.faceDetectorLoading = false;
                State.faceDetectionActive = false;
                this.badge('AI wajah: gagal membaca kamera · mode manual', 'error');
                this.clearOverlay();
                return;
              }

              if (gen !== this._gen) return;
              this.active = true;
              State.faceDetectorLoading = false;
              State.faceDetectionActive = true;
              this.badge(`AI wajah: pulih · (${this.backendOrder[this._backendIndex] || 'auto'})`, 'ready');
            } finally {
              this._processing = false;
            }

            if (this.active && gen === this._gen) {
              this.rafId = window.requestAnimationFrame(loop);
            }
          };

          this.rafId = window.requestAnimationFrame(loop);
        } catch (error) {
          State.faceDetectorLoading = false;
          State.faceDetectionActive = false;
          this.active = false;
          this._degraded = true;
          State.faceDetector = null;
          this.badge('AI wajah: model gagal dimuat · mode manual', 'error');
          console.warn('Face detector unavailable:', error);
        }
      },
      stop(reset=true) {
        this._gen++;
        this.active = false;
        this._processing = false;
        State.faceDetectorLoading = false;
        if (this.rafId) window.cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        this.lastVideoTime = -1;
        this.lastDetectPerfMs = 0;
        this.lastDetectDurationMs = 0;
        this.runtimeEmaMs = 0;
        this.runtimeSamples = 0;
        this.nextDetectAt = 0;
        this.lastCount = 0;

        if (reset) {
          this.stableHits = 0;
          State.faceDetectionStable = 0;
          State.faceDetectionCount = 0;
        }

        State.faceDetectionActive = false;
        this.clearOverlay();
      },
      readyForMemberPhoto() {
        if (State.photoTarget !== 'anggota') return true;
        if (!FEATURE_AI_FACE_DETECTOR_ENABLED) return true;
        if (this._degraded) return true;

        return (
          this.active &&
          !State.faceDetectorLoading &&
          this.stableHits >= 3 &&
          this.lastCount >= 1
        );
      },
      async _blobToInput(blob) {
        if (typeof createImageBitmap === 'function') {
          return {
            input: await createImageBitmap(blob),
            cleanup: value => value?.close?.()
          };
        }

        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Browser gagal membaca foto hasil capture.'));
        });
        return {
          input: img,
          cleanup: () => URL.revokeObjectURL(url)
        };
      },
      async verifyImageBlob(blob, target = State.photoTarget) {
        if (target !== 'anggota') return { ok:true, count:0 };
        if (!blob) return { ok:false, count:0, reason:'Foto tidak tersedia.' };
        if (!FEATURE_AI_FACE_DETECTOR_ENABLED || this._degraded) {
          return { ok:true, count:0, skipped:true, reason:'AI wajah tidak tersedia; pemeriksaan manual dilewati.' };
        }

        try {
          const detector = this.imageDetector || await this.loadImageDetector();
          const { input, cleanup } = await this._blobToInput(blob);
          try {
            const result = await detector.detect(input, this.previewConfig);
            const detections = this._resultFaces(result);
            const count = detections.length;
            this.lastCount = count;
            State.faceDetectionCount = count;
            return { ok: count >= 1, count };
          } finally {
            try { cleanup?.(input); } catch (_) {}
          }
        } catch (error) {
          console.warn('FaceDetection.verifyImageBlob:', error);
          this._degraded = true;
          return {
            ok: true,
            count: 0,
            skipped: true,
            reason: 'AI wajah gagal memeriksa foto; pemeriksaan manual dilewati.'
          };
        }
      },
      disposeEngineOnly() {
        const engine = this.detector;
        this.detector = null;
        this.imageDetector = null;
        State.faceDetector = null;
        try { engine?.models?.reset?.(); } catch (error) {
          console.warn('Human.js models.reset gagal:', error);
        }
      },
      async selfCheck() {
        const requiredIds = [
          'camera-stream',
          'face-detection-overlay',
          'face-detection-badge'
        ];
        const missingIds = requiredIds.filter(id => !document.getElementById(id));
        const methods = ['load','start','stop','readyForMemberPhoto','verifyImageBlob','dispose'];
        const missingMethods = methods.filter(name => typeof this[name] !== 'function');

        const result = {
          featureEnabled: FEATURE_AI_FACE_DETECTOR_ENABLED,
          missingIds,
          missingMethods,
          cspSecureContext: window.isSecureContext !== false
        };

        if (missingIds.length || missingMethods.length) {
          console.error('FaceDetection self-check FAILED:', result);
          return false;
        }

        console.info(
          `FaceDetection self-check OK: Human.js ${this.modelUrl.includes('@3.3.6') ? '3.3.6' : 'CDN'} · max=${HUMAN_MAX_FACES} wajah · lazy-load · fallback=manual`
        );
        return true;
      },
      dispose() {
        this.stop();
        this._loadSeq++;
        this._imageLoadSeq++;
        if (this._badgeTimer) window.clearTimeout(this._badgeTimer);
        this._badgeTimer = 0;

        this.disposeEngineOnly();
        this.module = null;
        this.filesetResolver = null;
        this.loadingPromise = null;
        this.imageLoadingPromise = null;
        this._degraded = false;
        State.faceDetector = null;
        State.faceDetectorLoading = false;
      },
      async verifyCurrentFrame(video) {
        if (State.photoTarget !== 'anggota') return { ok:true, count:0 };
        if (!FEATURE_AI_FACE_DETECTOR_ENABLED || this._degraded) return { ok:true, count:0, skipped:true };
        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          return { ok:false, count:0, reason:'AI face detector belum siap.' };
        }

        try {
          const result = await this._detect(video, this.previewConfig);
          const count = this._resultFaces(result).length;
          this.lastCount = count;
          State.faceDetectionCount = count;
          return { ok: count >= 1, count };
        } catch (error) {
          console.warn('Face detection final frame:', error);
          this._degraded = true;
          return { ok:true, count:0, skipped:true, reason:'AI gagal membaca frame terakhir; pemeriksaan manual dilewati.' };
        }
      }
    };

    const Camera = {
      _gen: 0,
      _withTimeout(promise, ms, message) {
        let timer = null;
        return Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = window.setTimeout(() => {
              const error = new Error(message);
              error.code = 'TIMEOUT';
              reject(error);
            }, ms);
          })
        ]).finally(() => {
          if (timer !== null) window.clearTimeout(timer);
        });
      },
      async start() {
        if (State.cameraStarting) return;
        if (!State.performance) Performance.apply();
        this.hideError();
        this.setLoading(true, 'Menyiapkan kamera…');
        this.stop();
        const gen = this._gen;
        State.cameraStarting = true;

        try {
          if (DeepARCamera.configured()) {
            let handled = false;
            try {
              handled = await this._withTimeout(
                DeepARCamera.start(),
                15000,
                'Kamera tidak merespons. Tutup aplikasi lain yang memakai kamera, lalu tekan Coba lagi.'
              );
            } catch (error) {
              // Timeout/error setelah engine terbentuk: dispose engine stale
              // sebelum kamera native mengambil alih.
              try {
                await DeepARCamera.shutdown();
              } catch (_) {}
              State.deepARError = error;
              handled = false;
            }

            if (gen !== this._gen) return;
            if (handled) {
              const cameraWrap = Util.el('camera-panel');
              cameraWrap?.classList.toggle('motion-camera', !document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced'));
              this.setLoading(false);
              return;
            }
          }

          const video = Util.el('camera-stream');
          if (
            window.isSecureContext === false
          ) {
            throw new DOMException(
              'Akses kamera membutuhkan HTTPS atau localhost.',
              'SecurityError'
            );
          }

          if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Browser ini tidak mendukung akses kamera. Gunakan Chrome, Edge, Safari, atau browser modern lain.');
          }
          const adaptive = Performance.cameraConstraints();
          const constraintsList = [
            adaptive,
            { video:{ facingMode:{ ideal:State.camFacingMode }, width:{ ideal:640 }, height:{ ideal:480 }, frameRate:{ ideal:20, max:20 } }, audio:false },
            { video:{ facingMode:State.camFacingMode }, audio:false },
            { video:true, audio:false }
          ];
          let lastError = null;
          let stream = null;
          for (const constraints of constraintsList) {
            const pending = navigator.mediaDevices.getUserMedia(constraints);
            try {
              stream = await this._withTimeout(pending, 12000, 'Kamera tidak merespons. Tutup aplikasi lain yang memakai kamera, lalu tekan Coba lagi.');
              break;
            } catch (error) {
              lastError = error;
              // getUserMedia yang timeout tetap dapat selesai belakangan.
              pending.then(
                lateStream => lateStream?.getTracks?.().forEach(track => track.stop()),
                () => {}
              );

              // Request ini sudah obsolete akibat stop/restart/navigation.
              // Jangan mencoba constraint berikutnya setelah generation berubah.
              if (gen !== this._gen) break;

              // Timeout berarti request lama masih mungkin hidup.
              // Jangan menyalakan request kamera kedua/ketiga.
              if (error?.code === 'TIMEOUT') break;

              // Permission denial adalah keputusan user/browser; jangan memicu
              // rangkaian fallback yang dapat menimbulkan prompt berulang.
              if (
                error?.name === 'NotAllowedError' ||
                error?.name === 'PermissionDeniedError'
              ) break;

              // Capability error tetap boleh mencoba constraint berikutnya
              // yang lebih sederhana.
            }
          }
          if (gen !== this._gen) {
            stream?.getTracks?.().forEach(track => track.stop());
            return;
          }
          if (!stream) throw lastError || new Error('Kamera tidak dapat dibuka.');
          State.camStream = stream;
          video.srcObject = stream;
          stream.getTracks().forEach(track => {
            track.addEventListener('ended', () => {
              if (State.camStream !== stream || State.currentPanel !== 'student') return;
              State.camStream = null;
              const liveVideo = Util.el('camera-stream');
              if (liveVideo?.srcObject === stream) {
                liveVideo.pause?.();
                liveVideo.srcObject = null;
              }
              this.showError('Koneksi kamera terputus. Tekan Coba lagi.');
              this.setLoading(false);
            }, { once:true });
          });
          const activeTrack = stream.getVideoTracks?.()[0];
          const actualFacing = activeTrack?.getSettings?.().facingMode;
          if (actualFacing === 'user' || actualFacing === 'environment') {
            State.camFacingMode = actualFacing;
          }
          const effectiveFacing = actualFacing || State.camFacingMode;
          video.style.transform = effectiveFacing === 'user' ? 'scaleX(-1)' : 'none';
          const cameraWrap = video.closest('.camera-wrap');
          if (cameraWrap) {
            const motionOn = !document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced');
            cameraWrap.classList.toggle('motion-camera', motionOn);
          }
          try {
            const playPromise = video.play();

            if (playPromise && typeof playPromise.then === 'function') {
              await this._withTimeout(
                playPromise,
                5000,
                'Preview kamera tidak dapat diputar. Tekan Coba lagi.'
              );
            }
          } catch (error) {
            throw error?.code === 'TIMEOUT'
              ? error
              : new Error(
                  error?.message ||
                  'Preview kamera tidak dapat diputar. Tekan Coba lagi.'
                );
          }

          const currentDataReady = await new Promise(resolve => {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              resolve(true);
              return;
            }

            let timer = null;
            const cleanup = () => {
              video.removeEventListener('loadeddata', onLoaded);
              video.removeEventListener('canplay', onLoaded);
              if (timer !== null) window.clearTimeout(timer);
            };
            const onLoaded = () => {
              cleanup();
              resolve(true);
            };

            timer = window.setTimeout(() => {
              cleanup();
              resolve(false);
            }, 5000);

            video.addEventListener('loadeddata', onLoaded, { once:true });
            video.addEventListener('canplay', onLoaded, { once:true });
          });
          if (gen !== this._gen) return;
          if (
            !currentDataReady ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.paused
          ) {
            throw new Error('Kamera belum siap. Tekan Coba lagi.');
          }
          this.setLoading(false);
          if (gen === this._gen && State.photoTarget === 'anggota' && State.camStream && this.requiresMemberFace()) {
            FaceDetection.start(video);
          } else {
            FaceDetection.stop();
          }
        } catch (error) {
          if (gen !== this._gen) return;
          this.setLoading(false);
          this.stop();
          const message = this.humanizeError(error);
          this.showError(message);
          UI.toast(message, 'error');
        } finally {
          if (gen === this._gen) State.cameraStarting = false;
        }
      },
      stop() {
        this._gen++;
        // Hentikan state FaceDetection bersamaan dengan lifecycle kamera.
        // Tanpa ini, detector dapat tetap aktif/marked-ready setelah stream
        // dihentikan dan baru dibersihkan pada loop berikutnya atau restart.
        FaceDetection.stop();
        try {
          State.camStream?.getTracks()?.forEach(track => track.stop());
        } catch (_) {}
        State.camStream = null;
        DeepARCamera.stop();
        const video = Util.el('camera-stream');
        if (video) {
          video.srcObject = null;
          video.closest('.camera-wrap')?.classList.remove('motion-camera');
        }
        State.cameraStarting = false;
      },
      async switchCamera() {
        if (State.cameraStarting) return;

        const requestGen = this._gen;
        State.camFacingMode = State.camFacingMode === 'environment' ? 'user' : 'environment';

        if (State.deepAR) {
          State.cameraStarting = true;
          try {
            let handled = false;
            try {
              handled = await this._withTimeout(
                DeepARCamera.switchCamera(),
                12000,
                'Ganti kamera tidak merespons.'
              );
            } catch (_) {
              // Timeout switch harus benar-benar dispose engine lama.
              // Jangan hanya stopCamera(), karena operasi startCamera lama
              // masih mungkin menyelesaikan promise-nya belakangan.
              await DeepARCamera.shutdown();
            }
            if (handled) return;
            if (requestGen !== this._gen || State.currentPanel !== 'student') return;
          } finally {
            State.cameraStarting = false;
          }
        }

        if (State.currentPanel !== 'student') return;
        await this.start();
      },
      async retry() { await this.start(); },
      setLoading(show, text) {
        const layer = Util.el('camera-loading');
        const label = Util.el('camera-loading-text');
        if (label && text) label.textContent = text;
        if (layer) layer.hidden = !show;
      },
      showError(message) {
        const box = Util.el('camera-error');
        if (!box) return;
        box.textContent = message;
        box.classList.remove('hidden', 'shake-animation');
        if (!document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced')) {
          void box.offsetWidth;
          box.classList.add('shake-animation');
        }
      },
      hideError() { Util.el('camera-error')?.classList.add('hidden'); },
      humanizeError(error) {
        const name = error?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Izin kamera ditolak. Buka pengaturan browser lalu izinkan kamera untuk situs ini.';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Kamera tidak ditemukan di perangkat ini.';
        if (name === 'NotReadableError' || name === 'TrackStartError') return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera/video lain lalu coba lagi.';
        if (name === 'OverconstrainedError') return 'Kamera tidak mendukung konfigurasi yang diminta. Coba ganti kamera.';
        if (window.isSecureContext === false) return 'Akses kamera membutuhkan HTTPS atau localhost.';
        return error?.message || 'Gagal mengakses kamera.';
      },
      requiresMemberFace() {
        if (State.photoTarget !== 'anggota') return false;
        const members = Config.membersForToday();
        if (!members.length) return false;
        const absentCount = Util.qsa('.absent-checkbox:checked').length;
        return absentCount < members.length;
      },
      async snapshot() {
        const btn = Util.el('btn-snap');
        const video = Util.el('camera-stream');
        if (!State.camStream && !State.deepAR) return UI.toast('Kamera belum aktif.', 'error');

        const faceRequiredForCapture = this.requiresMemberFace();
        const liveFaceGate =
          faceRequiredForCapture &&
          !State.deepAR;

        if (liveFaceGate) {
          if (State.faceDetectorLoading) return UI.toast('AI wajah masih memuat. Tunggu sebentar.', 'warning');
          if (!FaceDetection.readyForMemberPhoto()) {
            FaceDetection.badge('AI wajah: deteksi wajah diperlukan', 'warning');
            return UI.toast('Wajah belum terdeteksi dengan stabil. Arahkan kamera ke wajah anggota dan tunggu sampai status siap.', 'warning');
          }
        }

        const captureGen = this._gen;
        const captureTarget = State.photoTarget;
        const capturePromise = State.deepAR
          ? DeepARCamera.snapshot()
          : ImagePipeline.videoToBlob(video);

        UI.setButtonBusy(btn, true, 'Memproses…');
        try {
          const blob = await this._withTimeout(
            capturePromise,
            10000,
            'Pengambilan foto tidak merespons. Tekan Coba lagi.'
          );

          // Capture menjadi stale jika user pindah panel, stop/restart kamera,
          // atau lifecycle kamera dibatalkan selama capture berjalan.
          if (
            captureGen !== this._gen ||
            State.currentPanel !== 'student'
          ) {
            return;
          }

          if (!(blob instanceof Blob) || !blob.size) {
            throw new Error('File foto tidak valid. Tekan Coba lagi.');
          }

          UI.flashCapture();
          if (captureTarget === 'anggota') {
            if (faceRequiredForCapture) {
              if (State.deepAR) {
                FaceDetection.badge('AI wajah: memverifikasi foto…', 'warning');
                const verification = await FaceDetection.verifyImageBlob(blob, captureTarget);
                if (!verification.ok) {
                  const verificationMessage = verification.reason || 'Wajah anggota tidak terdeteksi pada foto. Ambil foto ulang.';
                  FaceDetection.badge(verification.reason ? 'AI wajah: pemeriksaan gagal' : 'AI wajah: wajah tidak terdeteksi', verification.reason ? 'error' : 'warning');
                  throw new Error(verificationMessage);
                }
                FaceDetection.badge(`${verification.count} wajah terdeteksi · siap`, 'ready');
              } else {
                const verification = await FaceDetection.verifyImageBlob(blob, captureTarget);
                if (!verification.ok) {
                  const verificationMessage = verification.reason || 'Wajah anggota tidak terdeteksi pada foto yang diambil. Foto tidak disimpan; silakan ambil foto ulang.';
                  FaceDetection.badge(verification.reason ? 'AI wajah: pemeriksaan gagal' : 'AI wajah: wajah tidak terdeteksi', verification.reason ? 'error' : 'warning');
                  throw new Error(verificationMessage);
                }
                FaceDetection.badge(`${verification.count} wajah terdeteksi · siap`, 'ready');
              }
            } else {
              FaceDetection.badge('AI wajah: tidak diperlukan · semua anggota tidak hadir', '');
            }
            if (captureGen !== this._gen || State.currentPanel !== 'student') return;
            this.storePhoto('anggota', blob);

            // Jangan menimpa pilihan tab user jika selama capture
            // dia sudah berpindah ke kondisi.
            if (State.photoTarget === 'anggota') {
              this.setTarget('kondisi');
            }

            UI.toast(`Foto anggota siap · ${Util.bytesToMB(blob.size)}`, 'success');
            App.updateStudentProgress(2);
          } else {
            this.storePhoto('kondisi', blob);
            UI.toast(`Foto kelas siap · ${Util.bytesToMB(blob.size)}`, 'success');
          }

          if (State.blobAnggota && State.blobKondisi) {
            this.stop();
            Util.el('camera-card').classList.add('hidden');
            Util.el('camera-complete-box').classList.remove('hidden');
            const submitButton = Util.el('btn-submit-report');
            submitButton.disabled = false;
            UI.pulsePrimary('btn-submit-report');
            App.updateStudentProgress(3);
            AI.analyzeSafely();
          }
        } catch (error) {
          UI.toast(error?.message || 'Gagal memproses foto.', 'error');
        } finally {
          UI.setButtonBusy(btn, false);
        }
      },
      storePhoto(target, blob) {
        setUnsavedChangesGuard(true);
        if (target === 'anggota') {
          if (State.urlAnggota) URL.revokeObjectURL(State.urlAnggota);
          State.blobAnggota = blob;
          State.urlAnggota = URL.createObjectURL(blob);
          const img = Util.el('thumb-anggota');
          img.src = State.urlAnggota;
          img.alt = 'Foto anggota piket';
          img.removeAttribute('aria-hidden');
          img.style.display = 'block';
          Util.el('placeholder-anggota').classList.add('hidden');
        } else {
          if (State.urlKondisi) URL.revokeObjectURL(State.urlKondisi);
          State.blobKondisi = blob;
          State.urlKondisi = URL.createObjectURL(blob);
          const img = Util.el('thumb-kondisi');
          img.src = State.urlKondisi;
          img.alt = 'Foto kondisi kelas';
          img.removeAttribute('aria-hidden');
          img.style.display = 'block';
          Util.el('placeholder-kondisi').classList.add('hidden');
        }
      },
      setTarget(target) {
        const previousTarget = State.photoTarget;
        State.photoTarget = target === 'kondisi' ? 'kondisi' : 'anggota';
        const changedTarget = previousTarget !== State.photoTarget;
        const cameraPanel = Util.el('camera-panel');
        cameraPanel?.classList.toggle('photo-ratio-portrait', State.photoTarget === 'anggota');
        cameraPanel?.classList.toggle('photo-ratio-landscape', State.photoTarget === 'kondisi');
        const a = Util.el('btn-tab-anggota');
        const k = Util.el('btn-tab-kondisi');
        a?.classList.toggle('active', State.photoTarget === 'anggota');
        k?.classList.toggle('active', State.photoTarget === 'kondisi');
        a?.setAttribute('aria-selected', String(State.photoTarget === 'anggota'));
        k?.setAttribute('aria-selected', String(State.photoTarget === 'kondisi'));
        a?.setAttribute('tabindex', State.photoTarget === 'anggota' ? '0' : '-1');
        k?.setAttribute('tabindex', State.photoTarget === 'kondisi' ? '0' : '-1');
        Util.el('camera-panel')?.setAttribute(
          'aria-labelledby',
          State.photoTarget === 'anggota' ? 'btn-tab-anggota' : 'btn-tab-kondisi'
        );
        Util.el('camera-instruction').textContent = State.photoTarget === 'anggota'
          ? 'Arahkan kamera ke semua anggota yang hadir. AI akan memverifikasi keberadaan wajah sebelum foto anggota diambil.'
          : 'Ambil foto kondisi area/kelengkapan kelas. AI wajah tidak diperlukan untuk foto ini.';
        if (State.photoTarget === 'anggota' && State.camStream && this.requiresMemberFace()) {
          FaceDetection.start(Util.el('camera-stream'));
        } else {
          FaceDetection.stop();
          FaceDetection.badge('AI wajah: tidak diperlukan', '');
        }
        DeepARCamera.setBeauty(State.photoTarget === 'anggota');
        if (
          changedTarget &&
          State.currentPanel === 'student' &&
          State.camStream &&
          !State.submitInFlight
        ) {
          void this.start();
        }
      }
    };
    /* =========================================================
       AI ADAPTER — tidak pernah memblokir submit dan tidak mengarang skor
       Mendukung optional window.PiketAI atau ./ai-engine.js jika tersedia.
       ========================================================= */
    const AI = {
      module: null,
      loaded: false,
      loadPromise: null,
      loadSeq: 0,
      async loadOptionalEngine() {
        if (this.loaded) return this.module;
        if (this.loadPromise) return this.loadPromise;

        const seq = ++this.loadSeq;
        const loadTask = (async () => {
          try {
            if (window.PiketAI?.analyze) return window.PiketAI;
            const mod = await import('./ai-engine.js');
            const engine = mod?.default || mod?.PiketAI || mod?.AIEngine || mod;
            return engine && typeof engine.analyze === 'function' ? engine : null;
          } catch (_) {
            return null;
          }
        })();

        this.loadPromise = loadTask.then(engine => {
          if (seq !== this.loadSeq) return null;
          this.loadPromise = null;
          if (engine && typeof engine.analyze === 'function') {
            this.module = engine;
            this.loaded = true;
            return engine;
          }
          this.module = null;
          this.loaded = false;
          return null;
        }, () => {
          if (seq === this.loadSeq) {
            this.loadPromise = null;
            this.module = null;
            this.loaded = false;
          }
          return null;
        });

        // Timeout membebaskan tracking hanya untuk attempt yang sedang ditunggu.
        // Import lama boleh selesai belakangan, tetapi tidak boleh mempublikasikan
        // hasil ke lifecycle loader yang sudah diganti.
        const trackedPromise = this.loadPromise;
        return Promise.race([
          trackedPromise,
          Util.sleep(4500).then(() => {
            if (this.loadPromise === trackedPromise) {
              this.loadSeq++;
              this.loadPromise = null;
              this.module = null;
              this.loaded = false;
            }
            return null;
          })
        ]);
      },
      async analyzeSafely() {
        const box = Util.el('ai-result');
        const runToken = ++State.aiRunToken;
        State.aiController?.abort();
        State.aiController = null;
        let controller = null;
        UI.setStatus(box, 'Menjalankan pemeriksaan otomatis…', 'info');

        // Snapshot input pada awal run agar microtask AI tidak pernah membaca
        // Blob dari sesi foto yang sudah berubah akibat Retake.
        const inputAnggota = State.blobAnggota;
        const inputKondisi = State.blobKondisi;
        if (!(inputAnggota instanceof Blob) || !(inputKondisi instanceof Blob)) {
          return;
        }

        try {
          if (!Performance.aiAllowed()) {
            UI.setStatus(box, 'Pemeriksaan AI dilewati pada mode hemat agar perangkat tetap ringan. Laporan tetap bisa dikirim.', 'warning');
            return;
          }
          const engine = await Promise.race([
            this.loadOptionalEngine(),
            Util.sleep(4500).then(() => null)
          ]);
          if (runToken !== State.aiRunToken) return;
          if (!engine) {
            UI.setStatus(box, 'AI eksternal belum tersedia. Foto tetap valid dan bisa dikirim; tidak ada skor AI palsu yang ditampilkan.', 'info');
            return;
          }

          controller = new AbortController();
          State.aiController = controller;
          const timeoutMs = Performance.aiTimeout();
          let result;
          {
            const aiStartedAt = performance.now();
            let timerId = null;
            let timedOut = false;
            const AI_ABORTED = Symbol('AI_ABORTED');
            const analysisPromise = Promise.resolve()
              .then(() => {
                if (
                  runToken !== State.aiRunToken ||
                  controller.signal.aborted
                ) {
                  return AI_ABORTED;
                }

                return engine.analyze({
                  anggota:inputAnggota,
                  kondisi:inputKondisi,
                onProgress:(message, percent) => {
                  if (
                    runToken !== State.aiRunToken ||
                    controller.signal.aborted
                  ) return;

                  const rawPercent = Number(percent);
                  const safePercent = Number.isFinite(rawPercent)
                    ? Util.clamp(rawPercent, 0, 100)
                    : null;

                  UI.setStatus(
                    box,
                    `${message || 'Menganalisis…'}${safePercent !== null ? ` (${Math.round(safePercent)}%)` : ''}`,
                    'info'
                  );
                },
                signal:controller.signal
                });
              })
              .catch(error => {
                // Abort akibat timeout atau pembatalan run lama adalah kondisi normal.
                if (controller.signal.aborted) return AI_ABORTED;
                throw error;
              });
            const timeoutPromise = new Promise((_, reject) => {
              timerId = window.setTimeout(() => {
                timedOut = true;
                controller.abort();
                Performance.recordAiRuntime(performance.now() - aiStartedAt, true);
                reject(new Error('AI timeout'));
              }, timeoutMs);
            });
            try {
              result = await Promise.race([analysisPromise, timeoutPromise]);
            } finally {
              if (timerId !== null) window.clearTimeout(timerId);
            }
            if (result === AI_ABORTED || runToken !== State.aiRunToken) return;
            if (!timedOut) Performance.recordAiRuntime(performance.now() - aiStartedAt);
          }
          if (runToken !== State.aiRunToken) return;
          if (!result || typeof result !== 'object') throw new Error('Respons AI tidak valid.');
          State.aiAnalysis = result;
          const notes = result.aiNotes || result.notes || 'Analisis AI selesai.';
          const rawConfidence = Number(result.confidence);
          const confidence = Number.isFinite(rawConfidence)
            ? Math.round(Util.clamp(rawConfidence, 0, 1) * 100)
            : null;

          const rawScore = Number(result.cleanlinessScore);
          const score = Number.isFinite(rawScore)
            ? Util.clamp(rawScore, 0, 100)
            : null;
          const pieces = [notes];
          if (score !== null) pieces.push(`Skor kebersihan: ${score}/100.`);
          if (confidence !== null) pieces.push(`Confidence: ${confidence}%.`);
          UI.setStatus(box, pieces.join(' '), 'success');
        } catch (error) {
          if (runToken !== State.aiRunToken) return;
          console.warn('AI non-fatal:', error);
          State.aiAnalysis = { available:false, error:String(error?.message || 'AI gagal') };
          UI.setStatus(box, 'Pemeriksaan AI gagal dimuat, tetapi fitur utama tetap aman. Laporan tidak diblokir oleh AI.', 'warning');
        } finally {
          if (State.aiController === controller) {
            State.aiController = null;
          }
        }
      }
    };

    /* =========================================================
       LOCAL PHOTO EVIDENCE — IndexedDB fallback
       Menyimpan Blob foto ketika cloud tidak tersedia/gagal.
       ========================================================= */
    const LocalMedia = {
      dbName: 'piket_media_v1',
      storeName: 'report_photos',
      async open() {
        if (!window.indexedDB) return null;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(this.dbName, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(this.storeName)) {
              db.createObjectStore(this.storeName, { keyPath: 'reportId' });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
          };
          request.onerror = () => reject(request.error || new Error('IndexedDB tidak tersedia.'));
        });
      },
      async saveReportPhotos(reportId, blobAnggota, blobKondisi) {
        let db = null;
        try {
          db = await this.open();
          if (!db) return false;
          await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put({
              reportId: String(reportId),
              anggota: blobAnggota || null,
              kondisi: blobKondisi || null,
              savedAt: new Date().toISOString()
            });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan foto lokal.'));
            tx.onabort = () => reject(tx.error || new Error('Penyimpanan foto lokal dibatalkan.'));
          });
          return true;
        } catch (error) {
          console.warn('LocalMedia.saveReportPhotos:', error);
          return false;
        } finally {
          try { db?.close(); } catch (_) {}
        }
      },
      async readReportPhotos(reportId) {
        let db = null;
        try {
          db = await this.open();
          if (!db) return null;
          return await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const request = tx.objectStore(this.storeName).get(String(reportId));
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('Gagal membaca foto lokal.'));
          });
        } catch (error) {
          console.warn('LocalMedia.readReportPhotos:', error);
          return null;
        } finally {
          try { db?.close(); } catch (_) {}
        }
      },
      async readReportPhotosBatch(reportIds) {
        let db = null;
        try {
          db = await this.open();
          if (!db) return new Map();

          const ids = [...new Set(
            (Array.isArray(reportIds) ? reportIds : [])
              .map(id => String(id))
          )];
          const result = new Map();
          if (!ids.length) return result;

          await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);

            ids.forEach(id => {
              const request = store.get(id);
              request.onsuccess = () => {
                if (request.result) result.set(id, request.result);
              };
              request.onerror = () => reject(
                request.error || new Error('Gagal membaca foto lokal.')
              );
            });

            tx.oncomplete = resolve;
            tx.onerror = () => reject(
              tx.error || new Error('Pembacaan foto lokal gagal.')
            );
            tx.onabort = () => reject(
              tx.error || new Error('Pembacaan foto lokal dibatalkan.')
            );
          });

          return result;
        } catch (error) {
          console.warn('LocalMedia.readReportPhotosBatch:', error);
          return new Map();
        } finally {
          try { db?.close(); } catch (_) {}
        }
      },
      async deleteReportPhotos(reportId) {
        let db = null;
        try {
          db = await this.open();
          if (!db) return false;
          await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(String(reportId));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Gagal menghapus foto lokal.'));
            tx.onabort = () => reject(tx.error || new Error('Penghapusan foto lokal dibatalkan.'));
          });
          return true;
        } catch (error) {
          console.warn('LocalMedia.deleteReportPhotos:', error);
          return false;
        } finally {
          try { db?.close(); } catch (_) {}
        }
      },
      async clearAll() {
        let db = null;
        try {
          db = await this.open();
          if (!db) return false;
          await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Gagal mengosongkan IndexedDB.'));
            tx.onabort = () => reject(tx.error || new Error('Pengosongan IndexedDB dibatalkan.'));
          });
          return true;
        } catch (error) {
          console.warn('LocalMedia.clearAll:', error);
          return false;
        } finally {
          try { db?.close(); } catch (_) {}
        }
      }
    };

    /* =========================================================
       REPORTS
       ========================================================= */
    const Reports = {
      _localSyncPromise: null,
      _deleteSyncPromise: null,
      readLocal() {
        const data = Local.getJSON(STORAGE.reports, []);
        return Array.isArray(data) ? data : [];
      },
      writeLocal(reports) {
        const limited = reports.slice(0,50);
        const droppedPending = reports
          .slice(50)
          .some(report => report?.local_only === true);
        if (droppedPending) return false;
        return Local.setJSON(STORAGE.reports, limited);
      },
      isBusy() {
        return Boolean(this._localSyncPromise || this._deleteSyncPromise);
      },
      withResetGate(task, options = { mode:'shared' }) {
        if (!navigator.locks?.request) return task(null);
        return navigator.locks.request(
          'piket-reset-gate',
          options,
          task
        );
      },
      withLocalMutationLock(task) {
        if (!navigator.locks?.request) return task();
        return navigator.locks.request('piket-local-reports', task);
      },
      async updateLocal(mutator) {
        return this.withLocalMutationLock(() => {
          const current = this.readLocal();
          const next = mutator(current);

          if (!Array.isArray(next)) return false;
          return this.writeLocal(next);
        });
      },
      async addLocal(report) {
        return this.updateLocal(current => {
          current.unshift(report);
          return current;
        });
      },
      async deleteLocal(id) {
        return this.updateLocal(current =>
          current.filter(r => String(r.id) !== String(id))
        );
      },
      async finalizeCloudLocalReport(reportId, cloudReport) {
        // Tahap 1: durable metadata tetap ditandai local_only selama transisi.
        const staged = await this.updateLocal(items => {
          const next = items.map(item =>
            String(item.id) === String(reportId)
              ? { ...cloudReport, local_only: true }
              : item
          );

          return next.some(item => String(item.id) === String(reportId))
            ? next
            : null;
        });
        if (!staged) return false;

        // Tahap 2: cloud metadata dibuat final terlebih dahulu. Bila write cache
        // ini gagal, Blob lokal masih utuh dan laporan dapat direkonsiliasi ulang.
        const finalized = await this.updateLocal(items =>
          items.map(item =>
            String(item.id) === String(reportId)
              ? { ...cloudReport, local_only: false }
              : item
          )
        );
        if (!finalized) return false;

        // Tahap 3: evidence lokal kini hanya menjadi cache. Kegagalan cleanup
        // tidak boleh membatalkan status cloud yang sudah durable.
        const mediaDeleted = await LocalMedia.deleteReportPhotos(reportId);
        if (!mediaDeleted) {
          console.warn(
            'Reports.finalizeCloudLocalReport: cloud sudah final tetapi Blob lokal belum terhapus.',
            reportId
          );
        }
        return true;
      },
      readDeletedIds() {
        const raw = Local.getJSON(STORAGE.deletedReports, []);
        return new Set(Array.isArray(raw) ? raw.map(id => String(id)) : []);
      },
      async markDeleted(id) {
        return this.withLocalMutationLock(() => {
          const ids = this.readDeletedIds();
          ids.add(String(id));
          return Local.setJSON(STORAGE.deletedReports, Array.from(ids));
        });
      },
      async unmarkDeleted(id) {
        return this.withLocalMutationLock(() => {
          const ids = this.readDeletedIds();
          ids.delete(String(id));
          return Local.setJSON(STORAGE.deletedReports, Array.from(ids));
        });
      },
      withReportMutationLock(reportId, task) {
        if (!navigator.locks?.request) return task();

        const lockName = `piket-report:${String(reportId)}`;
        return navigator.locks.request(lockName, task);
      },
      async syncPendingDeletes({ skipResetGate = false, onlyId = null } = {}) {
        if (this._deleteSyncPromise) return this._deleteSyncPromise;

        const workflow = async () => {
          if (!Cloud.ready() || !Connection.isUsable()) return;

          const ids = onlyId !== null
            ? [String(onlyId)]
            : Array.from(this.readDeletedIds());
          for (const id of ids) {
            const processDelete = async () => {
              // Kondisi bisa berubah di tab lain selama kita menunggu lock.
              if (!this.readDeletedIds().has(String(id))) return;

              const finalizeDelete = async () => {
                const mediaDeleted = await LocalMedia.deleteReportPhotos(id);
                if (!mediaDeleted) return false;

                const localDeleted = await this.deleteLocal(id);
                if (!localDeleted) return false;

                await this.unmarkDeleted(id);
                return true;
              };

              try {
                const cloudContext = Cloud.captureContext();
                if (!cloudContext) return;

                const lookup = await Cloud.readReportById(id, cloudContext);
                const result = await Cloud.deleteReport(
                  id,
                  lookup.ok ? lookup.data : null,
                  cloudContext
                );
                if (result.ok) {
                  await finalizeDelete();
                  return;
                }
                if (/Tidak ada baris yang terhapus/i.test(result.message || '')) {
                  const verify = await Cloud.readReportById(id, cloudContext);
                  if (verify.ok && verify.data === null) {
                    await finalizeDelete();
                  }
                }
              } catch (_) {}
            };

            try {
              await this.withReportMutationLock(id, processDelete);
            } catch (_) {}
          }
        };

        const run = skipResetGate
          ? workflow()
          : this.withResetGate(workflow);

        this._deleteSyncPromise = run;
        try {
          return await run;
        } finally {
          if (this._deleteSyncPromise === run) this._deleteSyncPromise = null;
        }
      },
      async syncPendingLocalReports() {
        if (this._localSyncPromise) return this._localSyncPromise;

        const workflow = async () => {
          if (!Cloud.ready() || !Connection.isUsable()) return { synced:0, failed:0 };
          const deletedIds = this.readDeletedIds();
          const localReports = this.readLocal().filter(report => report?.local_only && !deletedIds.has(String(report.id)));
          let synced = 0;
          let failed = 0;

          for (const snapshot of localReports) {
            await this.withReportMutationLock(snapshot.id, async () => {
              const id = String(snapshot.id);
              const deletedNow = this.readDeletedIds();
              const report = this.readLocal().find(item => String(item.id) === id);

              // Report mungkin sudah dihapus oleh tab lain sejak snapshot dibuat.
              if (deletedNow.has(id) || !report?.local_only) return;

              try {
                const cloudContext = Cloud.captureContext();
                if (!cloudContext) { failed++; return; }

                const rawReportOrigin = String(report._cloudOrigin || '').trim();
                const reportOrigin = rawReportOrigin
                  ? Cloud.canonicalOrigin(rawReportOrigin)
                  : null;
                const reportBucket = String(report._cloudBucket || '').trim();

                if (rawReportOrigin && !reportOrigin) {
                  failed++;
                  console.warn(
                    'Cloud sync dihentikan: provenance backend tidak valid. Evidence lokal dipertahankan.',
                    report.id
                  );
                  return;
                }

                if (reportOrigin && reportOrigin !== cloudContext.url) {
                  failed++;
                  console.warn(
                    'Cloud sync dihentikan: backend asal laporan berbeda. Evidence lokal dipertahankan.',
                    report.id
                  );
                  return;
                }

                if (reportBucket && reportBucket !== cloudContext.bucket) {
                  failed++;
                  console.warn(
                    'Cloud sync dihentikan: bucket asal laporan berbeda. Evidence lokal dipertahankan.',
                    report.id
                  );
                  return;
                }

                // Legacy report tanpa provenance masih dapat diverifikasi dari URL foto.
                if (!reportOrigin) {
                  const legacyOrigins = [
                    report.photo_anggota_url,
                    report.photo_kondisi_url
                  ]
                    .filter(Boolean)
                    .map(url => {
                      try { return new URL(String(url)).origin; } catch (_) { return ''; }
                    })
                    .filter(Boolean);

                  if (
                    legacyOrigins.length &&
                    legacyOrigins.some(origin => origin !== cloudContext.url)
                  ) {
                    failed++;
                    console.warn(
                      'Cloud sync dihentikan: legacy report menunjuk backend berbeda. Evidence lokal dipertahankan.',
                      report.id
                    );
                    return;
                  }

                }

                const existing = await Cloud.readReportById(report.id, cloudContext);
                if (existing.ok && existing.data) {
                  const hasCompleteEvidence = await Cloud.hasCompleteEvidence(
                    existing.data,
                    cloudContext
                  );

                  if (!hasCompleteEvidence) {
                    // IndexedDB adalah safety net: jangan menyentuh row cloud
                    // parsial sebelum kedua Blob lokal benar-benar tersedia.
                    const media = await LocalMedia.readReportPhotos(report.id);

                    if (!media?.anggota || !media?.kondisi) {
                      failed++;
                      console.warn(
                        'Cloud sync: row cloud parsial ditemukan, tetapi evidence lokal tidak lengkap. ' +
                        'Row tidak dihapus agar data tidak semakin berisiko.',
                        report.id
                      );
                      return;
                    }

                    // Row parsial tetap dipertahankan. Soft-delete hanya mengisi
                    // deleted_at dan tidak mengubah primary key, sehingga insert ulang
                    // dengan ID yang sama akan rentan duplicate-key. Upload evidence baru
                    // lalu UPDATE row existing agar ID dan histori tetap konsisten.
                    const [photoAnggota, photoKondisi] = await Promise.all([
                      Cloud.uploadPhoto(media.anggota, 'anggota', `Foto anggota ${report.id}`, report.date_key, report.class_id, cloudContext),
                      Cloud.uploadPhoto(media.kondisi, 'kondisi', `Foto kelas ${report.id}`, report.date_key, report.class_id, cloudContext)
                    ]);
                    const uploadedPaths = [photoAnggota?.path, photoKondisi?.path].filter(Boolean);
                    if (!photoAnggota.ok || !photoKondisi.ok) {
                      if (uploadedPaths.length) await Cloud.deleteStoragePaths(uploadedPaths, cloudContext);
                      failed++;
                      return;
                    }

                    const repairedReport = {
                      ...report,
                      ...existing.data,
                      local_only:false,
                      photo_anggota_path: photoAnggota.path,
                      photo_kondisi_path: photoKondisi.path
                    };
                    const repaired = await Cloud.repairReport(
                      repairedReport,
                      photoAnggota.path,
                      photoKondisi.path,
                      cloudContext
                    );
                    if (!repaired.ok) {
                      if (uploadedPaths.length) await Cloud.deleteStoragePaths(uploadedPaths, cloudContext);
                      failed++;
                      console.warn(
                        'Cloud sync: row cloud parsial gagal diperbaiki. Evidence lokal dipertahankan.',
                        report.id,
                        repaired.message
                      );
                      return;
                    }

                    const verify = await Cloud.readReportById(report.id, cloudContext);
                    if (!verify.ok || !verify.data) {
                      // Setelah UPDATE sukses, jangan menghapus upload baru hanya karena
                      // pembacaan verifikasi gagal; row kemungkinan sudah menunjuk object tersebut.
                      failed++;
                      console.warn(
                        'Cloud sync: update row parsial berhasil, tetapi verifikasi belum dapat dilakukan. Evidence cloud dipertahankan.',
                        report.id
                      );
                      return;
                    }

                    const repairedComplete = await Cloud.hasCompleteEvidence(verify.data, cloudContext);
                    if (!repairedComplete) {
                      failed++;
                      console.warn(
                        'Cloud sync: row sudah diperbaiki tetapi kedua object Storage belum terbukti tersedia.',
                        report.id
                      );
                      return;
                    }

                    const oldPaths = [
                      Cloud.photoPath(existing.data, 'anggota', cloudContext),
                      Cloud.photoPath(existing.data, 'kondisi', cloudContext)
                    ].filter(Boolean);
                    const cleanupOld = oldPaths.filter(path => !uploadedPaths.includes(String(path)));
                    if (cleanupOld.length) {
                      const cleanup = await Cloud.deleteStoragePaths(cleanupOld, cloudContext);
                      if (!cleanup.ok) console.warn('Cloud sync: cleanup evidence parsial lama gagal:', cleanup.message);
                    }

                    const finalized = await this.finalizeCloudLocalReport(
                      report.id,
                      { ...report, ...verify.data, local_only:false }
                    );
                    if (!finalized) {
                      failed++;
                      return;
                    }
                    synced++;
                    return;
                  } else {
                    const cloudReport = {
                      ...report,
                      ...existing.data,
                      local_only:false
                    };
                    const finalized = await this.finalizeCloudLocalReport(
                      report.id,
                      cloudReport
                    );
                    if (!finalized) { failed++; return; }
                    synced++;
                    return;
                  }
                }
                if (!existing.ok) { failed++; return; }

                const existingPaths = [
                  Cloud.photoPath(report, 'anggota', cloudContext),
                  Cloud.photoPath(report, 'kondisi', cloudContext)
                ].filter(Boolean);

                if (existingPaths.length === 2) {
                  const existingEvidenceComplete = await Cloud.hasCompleteEvidence(
                    report,
                    cloudContext
                  );

                  if (!existingEvidenceComplete) {
                    console.warn(
                      'Cloud sync: URL/path legacy menunjuk object Storage yang tidak lengkap. ' +
                      'Evidence lokal dipertahankan dan akan diunggah ulang.',
                      report.id
                    );
                  } else {
                    const recoveredReport = { ...report, local_only:false };
                    const recovered = await Cloud.createReport(recoveredReport, cloudContext);

                    if (recovered.ok) {
                    const finalized = await this.finalizeCloudLocalReport(
                      report.id,
                      recoveredReport
                    );
                    if (!finalized) {
                      failed++;
                      return;
                    }
                    synced++;
                    return;
                  }

                  }

                  const verify = await Cloud.readReportById(report.id, cloudContext);

                  if (verify.ok && verify.data) {
                    const hasCompleteEvidence = await Cloud.hasCompleteEvidence(
                      verify.data,
                      cloudContext
                    );

                    if (!hasCompleteEvidence) {
                      failed++;
                      console.warn(
                        'Cloud sync: hasil INSERT ambigu menemukan row tanpa evidence foto lengkap. ' +
                        'Evidence lokal dipertahankan untuk mencegah kehilangan data.',
                        report.id
                      );
                      return;
                    }

                    const verifiedReport = {
                      ...report,
                      ...verify.data,
                      local_only:false
                    };
                    const finalized = await this.finalizeCloudLocalReport(
                      report.id,
                      verifiedReport
                    );
                    if (!finalized) {
                      failed++;
                      return;
                    }
                    synced++;
                    return;
                  }

                  if (!verify.ok) {
                    failed++;
                    return;
                  }

                  const cleanup = await Cloud.deleteStoragePaths(existingPaths, cloudContext);
                  if (!cleanup.ok) {
                    failed++;
                    return;
                  }
                }

                const media = await LocalMedia.readReportPhotos(report.id);
                if (!media?.anggota || !media?.kondisi) { failed++; return; }

                const [photoAnggota, photoKondisi] = await Promise.all([
                  Cloud.uploadPhoto(media.anggota, 'anggota', `Foto anggota ${report.id}`, report.date_key, report.class_id, cloudContext),
                  Cloud.uploadPhoto(media.kondisi, 'kondisi', `Foto kelas ${report.id}`, report.date_key, report.class_id, cloudContext)
                ]);
                const uploadedPaths = [photoAnggota?.path, photoKondisi?.path].filter(Boolean);
                if (!photoAnggota.ok || !photoKondisi.ok) {
                  if (uploadedPaths.length) await Cloud.deleteStoragePaths(uploadedPaths, cloudContext);
                  failed++;
                  return;
                }

                const cloudReport = {
                  ...report,
                  local_only:false,
                  photo_anggota_path: photoAnggota.path || null,
                  photo_kondisi_path: photoKondisi.path || null
                };
                const savedCloud = await Cloud.createReport(cloudReport, cloudContext);
                if (!savedCloud.ok) {
                  const verify = await Cloud.readReportById(report.id, cloudContext);
                  if (!(verify.ok && verify.data)) {
                    if (!verify.ok) {
                      console.warn('Cloud sync: hasil INSERT ambigu; foto cloud dipertahankan untuk mencegah kehilangan bukti.', report.id);
                      failed++;
                      return;
                    }
                    if (uploadedPaths.length) await Cloud.deleteStoragePaths(uploadedPaths, cloudContext);
                    failed++;
                    return;
                  }

                  const hasCompleteEvidence =
                    await Cloud.hasCompleteEvidence(
                      verify.data,
                      cloudContext
                    );

                  // URL/path valid saja tidak cukup. Jangan pernah menghapus
                  // evidence lokal sebelum kedua object Storage terbukti ada.
                  if (!hasCompleteEvidence) {
                    failed++;
                    console.warn(
                      'Cloud sync: hasil INSERT ambigu menemukan row tanpa kedua object foto. ' +
                      'Evidence lokal dipertahankan untuk rekonsiliasi.',
                      report.id
                    );
                    return;
                  }

                  const verifiedPaths = new Set([
                    Cloud.photoPath(verify.data, 'anggota', cloudContext),
                    Cloud.photoPath(verify.data, 'kondisi', cloudContext)
                  ].filter(Boolean));
                  const cleanupPaths = uploadedPaths.filter(path => !verifiedPaths.has(String(path)));
                  if (cleanupPaths.length) {
                    const cleanup = await Cloud.deleteStoragePaths(cleanupPaths, cloudContext);
                    if (!cleanup.ok) console.warn('Cloud sync: cleanup foto percobaan gagal:', cleanup.message);
                  }
                  cloudReport.photo_anggota_path = Cloud.photoPath(verify.data, 'anggota', cloudContext) || cloudReport.photo_anggota_path;
                  cloudReport.photo_kondisi_path = Cloud.photoPath(verify.data, 'kondisi', cloudContext) || cloudReport.photo_kondisi_path;
                }

                const finalized = await this.finalizeCloudLocalReport(
                  report.id,
                  cloudReport
                );
                if (!finalized) {
                  failed++;
                  return;
                }
                synced++;
              } catch (error) {
                failed++;
                console.warn('Reports.syncPendingLocalReports:', error);
              }
            });
          }
          return { synced, failed };
        };

        const run = this.withResetGate(workflow);

        this._localSyncPromise = run;
        try {
          return await run;
        } finally {
          if (this._localSyncPromise === run) this._localSyncPromise = null;
        }
      },
      async list(classId = State.config?.classId) {
        this.syncPendingDeletes().catch(() => {});
        const snapshotClassId = String(classId || '');
        const deletedIdsAtStart = this.readDeletedIds();
        const cloudContext = Cloud.captureContext();
        const configuredCloudContext = cloudContext || (
          State.config?.supabase?.url && State.config?.supabase?.key
            ? {
                url: Cloud.canonicalOrigin(State.config.supabase.url),
                bucket: String(State.config.supabase.bucket || 'piket-foto')
              }
            : null
        );
        const localData = snapshotClassId
          ? this.readLocal().filter(report =>
              !deletedIdsAtStart.has(String(report.id)) &&
              String(report.class_id || '') === snapshotClassId &&
              (
                report?.local_only === true ||
                !configuredCloudContext ||
                Cloud.reportMatchesContext(report, configuredCloudContext)
              )
            )
          : [];
        const cloud = await Cloud.readReports(snapshotClassId, cloudContext);

        const deletedIdsNow = this.readDeletedIds();

        // Tombstone yang ada pada awal request tetap dianggap valid untuk
        // seluruh render cycle ini, walaupun background sync sudah selesai.
        const effectiveDeletedIds = new Set([
          ...deletedIdsAtStart,
          ...deletedIdsNow
        ]);

        const visibleLocal = localData.filter(report =>
          !effectiveDeletedIds.has(String(report.id))
        );

        if (!cloud.ok) return visibleLocal;

        const visibleCloud = cloud.data.filter(report =>
          !effectiveDeletedIds.has(String(report.id)) &&
          String(report.class_id || '') === snapshotClassId
        );

        // Selama local_only:true, evidence lokal adalah sumber kebenaran untuk render.
        // Cloud duplicate yang mungkin parsial/rusak disembunyikan sampai finalisasi selesai.
        const localPendingIds = new Set(
          visibleLocal
            .filter(report => report?.local_only === true)
            .map(report => String(report.id))
        );
        const visibleCloudForRender = visibleCloud.filter(report =>
          !localPendingIds.has(String(report.id))
        );
        const pendingLocal = visibleLocal.filter(report =>
          report?.local_only === true
        );
        return [...visibleCloudForRender, ...pendingLocal].sort((a, b) => {
          const aTime = new Date(a.created_at || 0).getTime();
          const bTime = new Date(b.created_at || 0).getTime();
          return bTime - aTime;
        });
      }
    };



    /* =========================================================
       SMART DASHBOARD
       Fitur tambahan bersifat terisolasi dari core attendance flow; Asisten Piket aktif hanya di Ruang Guru.
       ========================================================= */
    const SmartDashboard = {
      chart: null,
      chartScriptPromise: null,
      reportsCache: [],
      reportsCacheAt: 0,
      reportsCacheClassId: '',
      reportsCacheClient: null,
      renderSeq: 0,
      chatOpen: true,
      _chatToggleEventBound: false,
      reasonAnalysisTimer: 0,
      reasonAnalysisToken: 0,

      init() {
        this.bindEvents();
        // Dashboard bersifat lazy: jangan menjalankan analitik/Chart.js saat
        // halaman baru dibuka ketika panel dashboard masih tertutup.
        const accordion = document.querySelector('.dashboard-accordion');
        accordion?.addEventListener('toggle', () => {
          if (accordion.open) void this.renderAll();
        });
        if (accordion?.open) void this.renderAll();
      },

      async openTeacherAccess() {
        // Ruang Guru sekarang memakai akses langsung; Supabase tetap dipakai
        // hanya untuk penyimpanan/sinkronisasi laporan bila dikonfigurasi.
        App.navigate('teacher');
        return true;
      },
      bindEvents() {
        Util.el('btn-refresh-smart-dashboard')?.addEventListener('click', () => this.renderAll(true));
        Util.el('btn-smart-analyze')?.addEventListener('click', () => this.analyzeReason());
        Util.el('btn-smart-clear')?.addEventListener('click', () => {
          const input = Util.el('smart-reason-input');
          const result = Util.el('smart-nlp-result');
          this.reasonAnalysisToken++;
          window.clearTimeout(this.reasonAnalysisTimer);
          this.reasonAnalysisTimer = 0;
          if (input) input.value = '';
          if (result) {
            result.dataset.tone = 'info';
            result.textContent = 'Masukkan alasan izin untuk dianalisis.';
          }
          input?.focus();
        });
        Util.el('smart-reason-input')?.addEventListener('keydown', event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') this.analyzeReason();
        });
        Util.el('smart-chat-form')?.addEventListener('submit', event => {
          event.preventDefault();
          this.sendChat();
        });
      },

      async loadReports(force = false) {
        const now = Date.now();
        const classIdSnapshot = String(State.config?.classId || '');
        const clientSnapshot = State.supabaseClient;
        const cacheMatchesContext =
          this.reportsCacheClassId === classIdSnapshot &&
          this.reportsCacheClient === clientSnapshot;

        if (
          !force &&
          cacheMatchesContext &&
          now - this.reportsCacheAt < 30000 &&
          Array.isArray(this.reportsCache)
        ) {
          return this.reportsCache;
        }

        const local = Reports.readLocal().filter(report =>
          String(report?.class_id || '') === classIdSnapshot
        );
        this.reportsCache = local;
        this.reportsCacheAt = now;
        this.reportsCacheClassId = classIdSnapshot;
        this.reportsCacheClient = clientSnapshot;

        try {
          if (classIdSnapshot && Connection.isUsable()) {
            const fresh = await Reports.list(classIdSnapshot);
            if (Array.isArray(fresh)) {
              this.reportsCache = fresh.slice();
              this.reportsCacheAt = Date.now();
              this.reportsCacheClassId = classIdSnapshot;
              this.reportsCacheClient = State.supabaseClient;
            }
          }
        } catch (error) {
          console.warn('SmartDashboard.loadReports:', error);
        }
        return this.reportsCache;
      },

      async renderAll(force = false) {
        const renderToken = ++this.renderSeq;
        const classIdSnapshot = String(State.config?.classId || '');
        const cacheMatchesContext =
          this.reportsCacheClassId === classIdSnapshot &&
          this.reportsCacheClient === State.supabaseClient;

        // Never paint a cache from another class/backend while the async
        // refresh is still resolving.
        this.renderLeaderboard(cacheMatchesContext ? this.reportsCache : []);
        this.updatePredictiveNote('Memuat histori laporan…');
        const reports = await this.loadReports(force);

        // Buang hasil async yang berasal dari kelas/request lama. Tanpa gate ini,
        // render yang lebih lambat dapat menimpa dashboard kelas yang baru dipilih.
        if (renderToken !== this.renderSeq || classIdSnapshot !== String(State.config?.classId || '')) return;

        this.renderLeaderboard(reports);
        await this.renderPredictive(reports, renderToken);
      },

      calculateAbsenceSeries(reports) {
        const buckets = Object.fromEntries(DAYS.map(day => [day, []]));
        const ordered = (Array.isArray(reports) ? reports : [])
          .filter(report => report && DAYS.includes(report.day))
          .map(report => {
            const total = Number(report.total_members || 0);
            const absent = Array.isArray(report.absents) ? report.absents.length : 0;
            const rate = total > 0 ? Util.clamp((absent / total) * 100, 0, 100) : 0;
            return { report, rate, ts: new Date(report.created_at || 0).getTime() || 0 };
          })
          .sort((a, b) => a.ts - b.ts);

        ordered.forEach(item => buckets[item.report.day].push(item.rate));
        const allRates = ordered.map(item => item.rate);
        const globalAvg = allRates.length ? allRates.reduce((a, b) => a + b, 0) / allRates.length : 0;
        const dayAvg = DAYS.map(day => {
          const values = buckets[day];
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : globalAvg;
        });

        let slope = 0;
        if (ordered.length >= 3) {
          const n = ordered.length;
          const xMean = (n - 1) / 2;
          const yMean = allRates.reduce((a, b) => a + b, 0) / n;
          let numerator = 0;
          let denominator = 0;
          ordered.forEach((item, index) => {
            const dx = index - xMean;
            numerator += dx * (item.rate - yMean);
            denominator += dx * dx;
          });
          slope = denominator ? numerator / denominator : 0;
        }

        const projectionStep = ordered.length ? Math.min(10, Math.max(1, ordered.length / 3)) : 0;
        const predicted = dayAvg.map(value => Util.clamp(value + slope * projectionStep, 0, 100));
        return { ordered, buckets, dayAvg, predicted, globalAvg, slope };
      },

      async ensureChartJs() {
        if (window.Chart) return window.Chart;
        if (this.chartScriptPromise) return this.chartScriptPromise;

        this.chartScriptPromise = new Promise((resolve, reject) => {
          const existing = document.querySelector('script[data-smart-chartjs]');
          if (existing) {
            existing.addEventListener('load', () => resolve(window.Chart), { once:true });
            existing.addEventListener('error', reject, { once:true });
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js';
          script.async = true;
          script.dataset.smartChartjs = '1';
          script.onload = () => window.Chart ? resolve(window.Chart) : reject(new Error('Chart.js tidak tersedia.'));
          script.onerror = () => reject(new Error('Chart.js gagal dimuat dari CDN.'));
          document.head.appendChild(script);
        }).catch(error => {
          this.chartScriptPromise = null;
          throw error;
        });
        return this.chartScriptPromise;
      },

      async renderPredictive(reports, renderToken = this.renderSeq) {
        const canvas = Util.el('smart-predictive-chart');
        if (renderToken !== this.renderSeq) return;
        if (!canvas) return;
        const note = Util.el('smart-predictive-note');
        const stats = this.calculateAbsenceSeries(reports);
        const enough = stats.ordered.length >= 2;

        if (!enough) {
          this.destroyChart();
          if (note) note.textContent = 'Belum cukup data untuk prediksi. Minimal 2 laporan tersimpan diperlukan; grafik akan terisi otomatis setelah laporan bertambah.';
          return;
        }

        try {
          const Chart = await this.ensureChartJs();
          if (!Chart) throw new Error('Chart.js tidak tersedia.');
          if (renderToken !== this.renderSeq) return;
          this.destroyChart();
          const ctx = canvas.getContext('2d');
          this.chart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: DAYS,
              datasets: [{
                label: 'Estimasi absen (%)',
                data: stats.predicted.map(value => Number(value.toFixed(1))),
                borderColor: '#dc2626',
                backgroundColor: 'rgba(220,38,38,.12)',
                borderWidth: 2,
                pointRadius: 3,
                pointHoverRadius: 5,
                tension: .35,
                fill: true
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${Number(ctx.parsed.y).toFixed(1)}%` } } },
              scales: { y: { beginAtZero:true, max:100, ticks:{ callback:value => `${value}%` } } }
            }
          });
          const realCount = stats.ordered.length;
          const trend = Math.abs(stats.slope) < .05 ? 'Tren relatif stabil.' : stats.slope > 0 ? 'Tren ketidakhadiran cenderung naik.' : 'Tren ketidakhadiran cenderung turun.';
          if (note) note.textContent = `${realCount} laporan dianalisis. Rata-rata ketidakhadiran ${stats.globalAvg.toFixed(1)}%. ${trend}`;
        } catch (error) {
          console.warn('SmartDashboard.renderPredictive:', error);
          if (note) note.textContent = 'Grafik belum dapat dimuat karena Chart.js tidak tersedia. Fitur laporan utama tetap normal.';
        }
      },

      destroyChart() {
        try { this.chart?.destroy?.(); } catch (_) {}
        this.chart = null;
      },

      updatePredictiveNote(text) {
        const note = Util.el('smart-predictive-note');
        if (note) note.textContent = text;
      },

      classifyReason(text) {
        const input = String(text || '').toLocaleLowerCase('id-ID').trim();
        const groups = [
          { label:'Sakit', tone:'warning', words:['demam','sakit','pusing','flu','batuk','mual','muntah'] },
          { label:'Izin Resmi', tone:'success', words:['keluarga','lomba','acara','sekolah','osis','upacara','kegiatan resmi','surat izin'] },
          { label:'Kondisi Mendesak', tone:'warning', words:['kecelakaan','darurat','urgent','rumah sakit','rs'] },
          { label:'Perlu Verifikasi', tone:'info', words:['terlambat','urusan','keperluan','transportasi','ban','kendaraan','hujan'] }
        ];
        for (const group of groups) {
          const match = group.words.find(word => {
            const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i').test(input);
          });
          if (match) return { ...group, match };
        }
        return { label:'Tidak ditemukan pola kuat', tone:'danger', match:'' };
      },

      analyzeReason() {
        const input = Util.el('smart-reason-input')?.value.trim() || '';
        const result = Util.el('smart-nlp-result');
        if (!result) return;

        this.reasonAnalysisToken++;
        const analysisToken = this.reasonAnalysisToken;
        window.clearTimeout(this.reasonAnalysisTimer);
        this.reasonAnalysisTimer = 0;

        if (!input) {
          result.dataset.tone = 'warning';
          result.textContent = 'Masukkan alasan terlebih dahulu.';
          return;
        }

        result.dataset.tone = 'info';
        result.textContent = 'Menganalisis alasan…';
        this.reasonAnalysisTimer = window.setTimeout(() => {
          this.reasonAnalysisTimer = 0;
          if (analysisToken !== this.reasonAnalysisToken) return;

          const out = this.classifyReason(input);
          result.dataset.tone = out.tone;
          result.textContent = out.match
            ? `Kategori: ${out.label}. Kata kunci terdeteksi: “${out.match}”. Ini adalah klasifikasi awal dan belum menggantikan verifikasi guru.`
            : `Kategori: ${out.label}. Tidak ditemukan pola kata kunci yang cukup kuat; sebaiknya diverifikasi manual.`;
        }, 450);
      },

      renderLeaderboard(reports) {
        const container = Util.el('smart-leaderboard');
        const note = Util.el('smart-leaderboard-note');
        if (!container) return;
        const members = new Map();
        DAYS.forEach(day => {
          (State.config?.members?.[day] || []).forEach(name => {
            const key = name.toLocaleLowerCase('id-ID');
            if (!members.has(key)) members.set(key, { name, scheduled:0, present:0 });
          });
        });

        (Array.isArray(reports) ? reports : []).forEach(report => {
          const scheduledToday = State.config?.members?.[report.day] || [];
          const absentSet = new Set((Array.isArray(report.absents) ? report.absents : []).map(name => String(name).toLocaleLowerCase('id-ID')));
          scheduledToday.forEach(name => {
            const key = name.toLocaleLowerCase('id-ID');
            const row = members.get(key) || { name, scheduled:0, present:0 };
            row.scheduled++;
            if (!absentSet.has(key)) row.present++;
            members.set(key, row);
          });
        });

        const ranking = [...members.values()]
          .filter(row => row.scheduled > 0)
          .map(row => ({
            ...row,
            attendance: row.scheduled ? row.present / row.scheduled : 0,
            points: Math.round((row.present / Math.max(1, row.scheduled)) * 1000) + Math.min(row.scheduled, 20) * 10
          }))
          .sort((a,b) => b.points - a.points || b.attendance - a.attendance || a.name.localeCompare(b.name,'id-ID'))
          .slice(0, 8);

        if (!ranking.length) {
          container.innerHTML = '<div class="smart-empty">Belum ada data kehadiran untuk membentuk leaderboard.</div>';
          if (note) note.textContent = 'Leaderboard akan aktif setelah laporan pertama tersimpan.';
          return;
        }

        const medals = ['🥇','🥈','🥉'];
        container.innerHTML = ranking.map((row,index) => `
          <div class="smart-rank">
            <div class="smart-rank-num">${medals[index] || `#${index + 1}`}</div>
            <div style="min-width:0">
              <div class="smart-rank-name">${Util.escapeHTML(row.name)}</div>
              <div class="smart-rank-meta">${row.present}/${row.scheduled} hadir · ${(row.attendance * 100).toFixed(0)}%</div>
            </div>
            <div class="smart-score">${row.points} Pts</div>
          </div>`).join('');
        if (note) note.textContent = `${ranking.length} anggota dengan histori piket terukur ditampilkan.`;
      },

      setChatAvailable(available) {
        const widget = Util.el('smart-chat-widget');
        if (!widget) return;
        widget.hidden = !available;
        if (!available) this.setChatOpen(false);
      },

      setChatOpen(open) {
        const widget = Util.el('smart-chat-widget');
        const toggle = Util.el('btn-smart-chat-toggle');
        const body = Util.el('smart-chat-body');
        const input = Util.el('smart-chat-form');
        if (!widget || !toggle) return;

        this.chatOpen = Boolean(open);
        if (this.chatOpen) widget.hidden = false;
        widget.classList.toggle('collapsed', !this.chatOpen);
        widget.dataset.open = String(this.chatOpen);

        // `hidden` menjadi sumber kebenaran kedua; ini menghindari konflik
        // dengan CSS transition/interpolate-size pada browser mobile.
        if (body) body.hidden = !this.chatOpen;
        if (input) input.hidden = !this.chatOpen;

        toggle.setAttribute('aria-expanded', String(this.chatOpen));
        toggle.setAttribute('aria-label', this.chatOpen ? 'Minimalkan Asisten Piket' : 'Buka Asisten Piket');
        toggle.setAttribute('title', this.chatOpen ? 'Turunkan Asisten Piket' : 'Buka Asisten Piket');
        toggle.innerHTML = `<i aria-hidden="true" class="fa-solid fa-chevron-${this.chatOpen ? 'down' : 'up'}"></i>`;
      },

      toggleChat() {
        const widget = Util.el('smart-chat-widget');
        if (!widget) return;
        this.setChatOpen(!widget.classList.contains('collapsed'));
      },

      appendChat(role, message) {
        const body = Util.el('smart-chat-body');
        if (!body) return;
        const node = document.createElement('div');
        node.className = `smart-chat-msg ${role}`;
        node.textContent = message;
        body.appendChild(node);
        body.scrollTop = body.scrollHeight;
      },

      weekdayAfter(baseDay, offset) {
        const index = DAYS.indexOf(baseDay);
        if (index < 0) return null;
        const target = index + offset;
        return target >= 0 && target < DAYS.length ? DAYS[target] : null;
      },

      async answerChat(message) {
        const text = String(message || '').toLocaleLowerCase('id-ID');
        const today = Time.dayName();
        const tomorrowDate = new Date(Time.now().getTime() + 24 * 60 * 60 * 1000);
        const tomorrow = Time.dayName(tomorrowDate);
        const reports = await this.loadReports(false);
        const todayMembers = Config.membersForToday();
        const latest = [...(reports || [])].sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];

        if (/lapor|buat laporan|kirim laporan/.test(text)) {
          if (!State.config?.classId) {
            return 'Konfigurasi kelas belum lengkap. Atur kelas terlebih dahulu.';
          }
          if (!DAYS.includes(today) || !todayMembers.length) {
            return `Hari ${today} bukan jadwal piket aktif atau belum ada anggota yang diatur.`;
          }
          if (!Limit.canSubmit()) {
            return 'Laporan hari ini sudah dikirim dari perangkat ini.';
          }
          setTimeout(() => App.navigate('student'), 0);
          return 'Saya membuka halaman laporan piket. Lengkapi absensi dan dua foto seperti biasa.';
        }
        if (/besok|esok/.test(text) && /piket|jadwal|siapa/.test(text)) {
          const list = DAYS.includes(tomorrow) ? Config.membersForToday(tomorrowDate) : [];
          return list.length ? `Besok (${tomorrow}) yang terdaftar piket: ${list.join(', ')}.` : `Besok (${tomorrow}) tidak memiliki jadwal piket aktif.`;
        }
        if (/hari ini|sekarang|piket/.test(text) && (/siapa|jadwal|yang piket/.test(text) || text.includes('piket'))) {
          return todayMembers.length ? `Hari ini ${today} yang terdaftar piket: ${todayMembers.join(', ')}.` : `Belum ada anggota yang diatur untuk ${today}.`;
        }
        if (/tidak hadir|absen|bolos/.test(text)) {
          const todayReport = (reports || []).find(report => report.date_key === Time.dateKey());
          if (todayReport) {
            const absent = Array.isArray(todayReport.absents) && todayReport.absents.length ? todayReport.absents.join(', ') : 'tidak ada';
            return `Pada laporan hari ini, yang tercatat tidak hadir: ${absent}.`;
          }
          return 'Belum ada laporan hari ini di data yang dapat saya baca.';
        }
        if (/statistik|prediksi|leaderboard|peringkat|ranking/.test(text)) {
          return reports?.length
            ? `Saat ini saya membaca ${reports.length} laporan. Grafik prediksi dan leaderboard di dashboard diperbarui dari data tersebut.`
            : 'Belum ada histori laporan yang cukup untuk statistik.';
        }
        if (/cloud|supabase|online|offline/.test(text)) {
          return Cloud.ready() ? 'Supabase terkonfigurasi. Laporan tetap memiliki cache lokal untuk menjaga alur saat koneksi berubah.' : 'Aplikasi saat ini berjalan dalam penyimpanan lokal.';
        }
        if (/laporan terakhir|terakhir/.test(text) && latest) {
          return `Laporan terakhir adalah ${latest.day || '-'} (${latest.date_key || '-'}), ${Number(latest.present_count || 0)} hadir dari ${Number(latest.total_members || 0)} anggota.`;
        }
        return 'Saya bisa membantu soal jadwal piket, siapa yang tidak hadir, statistik, koneksi cloud, atau membuka halaman laporan.';
      },

      sendChat() {
        const input = Util.el('smart-chat-input');
        const message = input?.value.trim() || '';
        if (!message) return;
        input.value = '';
        this.appendChat('user', message);
        this.appendChat('bot', '…');
        const body = Util.el('smart-chat-body');
        const pending = body?.lastElementChild;
        this.answerChat(message).then(reply => {
          if (pending) pending.textContent = reply;
          if (body) body.scrollTop = body.scrollHeight;
        }).catch(error => {
          console.warn('SmartDashboard.chat:', error);
          if (pending) pending.textContent = 'Maaf, data aplikasi belum dapat dibaca saat ini.';
        });
      }
    };

    /* =========================================================
       AI EXPERIENCE LAYER — Announcer
       Semua berjalan lokal; tidak memerlukan Gemini/API eksternal.
       Jika engine eksternal memiliki generate(), hasilnya boleh dipakai
       sebagai respons adaptif, tetapi fallback lokal selalu tersedia.
       ========================================================= */
    const PiketAIFeatures = {
      initialized: false,
      _attendanceSnapshot: null,
      _attendanceSnapshotAt: 0,
      announcerTimer: 0,
      announcerScheduleTimer: 0,
      _speakToken: 0,
      _activeSpeechFinish: null,
      _voicesReadyPromise: null,
      _voiceCache: null,
      _speechUnlocked: false,
      _announceInFlight: false,
      _permissionWarningKey: '',
      announceHour: 14,
      announceMinute: 50,
      announcePollMs: 5000,

      init() {
        if (this.initialized) return;
        this.initialized = true;
        this.bindEvents();
        this.bindVoiceEvents();
        this.syncAnnouncerUI();
        this.refreshAll();
        this.announcerTimer = window.setInterval(() => this.refreshAll(), 30000);
        this.announcerScheduleTimer = window.setInterval(() => this.tickAnnouncer(), this.announcePollMs);
        this.scheduleNextAnnouncerCheck();
      },

      bindEvents() {
        Util.el('btn-announcer-now-home')?.addEventListener('click', async () => {
          await this.unlockSpeechFromGesture();
          await this.announceNow(true);
        });
        Util.el('btn-announcer-toggle')?.addEventListener('click', async () => {
          const enabled = Local.get(STORAGE.announcerEnabled, '0') === '1';
          if (enabled) {
            Local.set(STORAGE.announcerEnabled, '0');
            this.syncAnnouncerUI();
            UI.toast('AI Announcer otomatis dimatikan.', 'info');
            return;
          }

          const unlocked = await this.unlockSpeechFromGesture();
          Local.set(STORAGE.announcerEnabled, '1');
          this.syncAnnouncerUI();
          this.scheduleNextAnnouncerCheck();
          UI.toast(
            unlocked
              ? 'AI Announcer aktif. Sistem akan mencoba mengumumkan pada 14.50.'
              : 'AI Announcer aktif, tetapi browser belum mengizinkan suara. Gunakan tombol Umumkan sekali untuk memberi izin.',
            unlocked ? 'success' : 'warning'
          );
        });
        Util.el('btn-announcer-now-teacher')?.addEventListener('click', async () => {
          await this.unlockSpeechFromGesture();
          await this.announceNow(true);
        });
      },

      bindVoiceEvents() {
        const synth = window.speechSynthesis;
        if (!synth) return;
        synth.addEventListener?.('voiceschanged', () => {
          this._voiceCache = null;
        });
      },

      monthKey(date = Time.now()) {
        const parts = Time.parts(date, 'en-US', { year:'numeric', month:'2-digit' });
        return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
      },

      dateKey(date = Time.now()) { return Time.dateKey(date); },

      timeParts(date = Time.now()) {
        const parts = Time.parts(date, 'en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
        return {
          hour:Number(parts.find(p => p.type === 'hour')?.value || 0),
          minute:Number(parts.find(p => p.type === 'minute')?.value || 0),
          second:Number(parts.find(p => p.type === 'second')?.value || 0)
        };
      },

      async getVoices() {
        const synth = window.speechSynthesis;
        if (!synth) return [];
        if (Array.isArray(this._voiceCache) && this._voiceCache.length) return this._voiceCache;

        let voices = synth.getVoices();
        if (voices.length) {
          this._voiceCache = voices.slice();
          return this._voiceCache;
        }

        if (!this._voicesReadyPromise) {
          this._voicesReadyPromise = new Promise(resolve => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              synth.removeEventListener?.('voiceschanged', onChange);
              resolve(synth.getVoices().slice());
            };
            const onChange = () => finish();
            const timer = window.setTimeout(finish, 1200);
            synth.addEventListener?.('voiceschanged', onChange, { once:true });
            const immediate = synth.getVoices();
            if (immediate.length) finish();
          }).finally(() => { this._voicesReadyPromise = null; });
        }

        voices = await this._voicesReadyPromise;
        this._voiceCache = voices.slice();
        return this._voiceCache;
      },

      pickNaturalVoice(voices = []) {
        const list = Array.isArray(voices) ? voices : [];
        const normalized = voice => ({
          voice,
          name:String(voice?.name || '').toLowerCase(),
          lang:String(voice?.lang || '').toLowerCase(),
          local:Boolean(voice?.localService)
        });
        const scored = list.map(normalized).map(item => {
          let score = 0;
          const { name, lang, local } = item;
          if (lang === 'id-id') score += 60;
          else if (lang.startsWith('id')) score += 45;
          else return { ...item, score:-1 };
          if (/google\s*bahasa\s*indonesia|google.*indones|bahasa indonesia/.test(name)) score += 80;
          if (/microsoft.*(ardi|gadis)/.test(name)) score += 78;
          if (/google/.test(name)) score += 24;
          if (/microsoft/.test(name)) score += 22;
          if (/natural|neural|online|premium/.test(name)) score += 26;
          if (local) score += 4;
          return { ...item, score };
        }).filter(item => item.score >= 0);
        scored.sort((a,b) => b.score - a.score);
        return scored[0]?.voice || null;
      },

      async unlockSpeechFromGesture() {
        if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return false;
        if (this._speechUnlocked) return true;
        try {
          const synth = window.speechSynthesis;
          // Penting: mulai speak SYNCHRONOUSLY dari event klik agar tetap berada
          // dalam user-gesture context browser. Jangan menunggu voiceschanged dulu.
          const initialVoices = synth.getVoices();
          this._voiceCache = initialVoices.length ? initialVoices.slice() : this._voiceCache;
          const utterance = new SpeechSynthesisUtterance('');
          utterance.lang = 'id-ID';
          utterance.volume = 0;
          utterance.rate = 1;
          utterance.pitch = 1;
          const initialVoice = this.pickNaturalVoice(initialVoices);
          if (initialVoice) utterance.voice = initialVoice;
          this._activeSpeechFinish?.(false);
          this._activeSpeechFinish = null;
          synth.cancel();
          synth.speak(utterance);
          this._speechUnlocked = true;

          // Daftar voice boleh baru tersedia sesudah user gesture; cache diperbarui
          // tanpa menghalangi unlock yang sudah dilakukan.
          if (!initialVoices.length) {
            void this.getVoices().catch(error => console.warn('Voice discovery:', error));
          }
          return true;
        } catch (error) {
          console.warn('PiketAIFeatures.unlockSpeechFromGesture:', error);
          return false;
        }
      },

      speak(message, elementId = null) {
        const token = ++this._speakToken;
        const el = elementId ? Util.el(elementId) : null;
        if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
          UI.toast('Browser ini tidak mendukung Text-to-Speech.', 'warning');
          return Promise.resolve(false);
        }

        return new Promise(resolve => {
          let settled = false;
          let timeout = 0;
          const finish = ok => {
            if (settled) return;
            settled = true;
            if (timeout) window.clearTimeout(timeout);
            if (this._activeSpeechFinish === finish) this._activeSpeechFinish = null;
            resolve(Boolean(ok));
          };

          try {
            const synth = window.speechSynthesis;
            this._activeSpeechFinish?.(false);
            this._activeSpeechFinish = finish;
            synth.cancel();
            const utterance = new SpeechSynthesisUtterance(String(message || ''));
            utterance.lang = 'id-ID';
            utterance.rate = 0.92;
            utterance.pitch = 1.0;
            utterance.volume = 1;
            const voice = this.pickNaturalVoice(this._voiceCache || synth.getVoices());
            if (voice) utterance.voice = voice;
            utterance.onstart = () => {
              if (token === this._speakToken) el?.classList.add('speaking');
            };
            utterance.onend = () => {
              if (token === this._speakToken) el?.classList.remove('speaking');
              finish(true);
            };
            utterance.onerror = event => {
              if (token === this._speakToken) el?.classList.remove('speaking');
              console.warn('Text-to-Speech error:', event?.error || event);
              finish(false);
            };
            timeout = window.setTimeout(() => {
              if (token === this._speakToken) el?.classList.remove('speaking');
              try { synth.cancel(); } catch (_) {}
              finish(false);
            }, 20000);
            synth.speak(utterance);
          } catch (error) {
            console.warn('PiketAIFeatures.speak:', error);
            finish(false);
          }
        });
      },

      normalizeStudentName(name) {
        return String(name || '')
          .trim()
          .replace(/\s+/g, ' ')
          .toLocaleLowerCase('id-ID');
      },

      attendanceSnapshotKey(classId = State.config?.classId, dateKey = Time.dateKey()) {
        const safeClass = String(classId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${STORAGE.announcerAttendancePrefix}${safeClass}_${dateKey}`;
      },

      invalidateAttendanceSnapshot() {
        this._attendanceSnapshot = null;
        this._attendanceSnapshotAt = 0;
      },

      async getTodayAttendanceSnapshot(forceFresh = false) {
        const now = Time.now();
        const dateKey = Time.dateKey(now);
        const day = Time.dayName(now);
        const classId = String(State.config?.classId || '');
        const members = Config.membersForToday(now).slice();
        const cacheKey = this.attendanceSnapshotKey(classId, dateKey);
        const cacheAgeMs = Math.max(0, performance.now() - (this._attendanceSnapshotAt || 0));

        if (!classId || !DAYS.includes(day) || !members.length) {
          return {
            classId,
            dateKey,
            day,
            members,
            present: [],
            absent: [],
            unverified: members.slice(),
            report: null,
            source: 'schedule-only'
          };
        }

        if (!forceFresh && this._attendanceSnapshot &&
            this._attendanceSnapshot.classId === classId &&
            this._attendanceSnapshot.dateKey === dateKey &&
            cacheAgeMs < 10000) {
          return this._attendanceSnapshot;
        }

        let reports = [];
        try {
          reports = await Reports.list(classId);
        } catch (error) {
          console.warn('Announcer: gagal membaca laporan hari ini:', error);
        }

        const todayReports = (Array.isArray(reports) ? reports : [])
          .filter(report =>
            String(report?.class_id || '') === classId &&
            String(report?.date_key || '') === dateKey &&
            String(report?.day || '') === day
          )
          .sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());

        const report = todayReports[0] || null;
        const absentSet = new Set(
          (Array.isArray(report?.absents) ? report.absents : [])
            .map(name => this.normalizeStudentName(name))
            .filter(Boolean)
        );

        // Penting: laporan piket memakai daftar `absents` untuk menentukan
        // siapa yang tidak hadir; nama terjadwal yang tidak berada di sana
        // dianggap hadir. Jangan menganggap hitungan wajah sebagai identitas,
        // karena Human.js di aplikasi ini hanya mendeteksi keberadaan wajah.
        const present = report
          ? members.filter(name => !absentSet.has(this.normalizeStudentName(name)))
          : [];
        const absent = report
          ? members.filter(name => absentSet.has(this.normalizeStudentName(name)))
          : [];

        const snapshot = {
          classId,
          dateKey,
          day,
          members,
          present,
          absent,
          unverified: report ? [] : members.slice(),
          report,
          source: report ? 'saved-report' : 'no-report'
        };

        // Database sementara hanya sebagai cache diagnostik/UX. Sumber kebenaran
        // tetap laporan lokal/cloud agar pengumuman tidak bergantung pada cache lama.
        try {
          Local.setJSON(cacheKey, {
            savedAt: new Date().toISOString(),
            classId,
            dateKey,
            day,
            members,
            present,
            absent,
            reportId: report?.id || null,
            source: snapshot.source
          });
        } catch (_) {}

        this._attendanceSnapshot = snapshot;
        this._attendanceSnapshotAt = performance.now();
        return snapshot;
      },

      async getAnnouncerMessage(forceFresh = false) {
        const snapshot = await this.getTodayAttendanceSnapshot(forceFresh);
        const members = Array.isArray(snapshot.members) ? snapshot.members : [];
        const targets = snapshot.report
          ? snapshot.absent.slice()
          : members.slice();

        let mode = snapshot.report ? 'tercatat tidak hadir' : 'belum ada laporan';

        if (!members.length) {
          return {
            message: 'Tidak ada jadwal piket aktif hari ini.',
            targets: [],
            mode: 'tidak ada jadwal'
          };
        }

        if (!targets.length && snapshot.report) {
          return {
            message: `Perhatian. Semua ${members.length} anggota piket hari ini sudah tercatat hadir. Terima kasih, tugas kalian aman.`,
            targets: [],
            mode: 'semua hadir'
          };
        }

        const spokenNames = targets.slice(0, 6).join(', ');
        const more = targets.length > 6 ? ` dan ${targets.length - 6} anggota lainnya` : '';
        const message = snapshot.report
          ? `Perhatian. ${spokenNames}${more} tercatat tidak hadir pada laporan piket hari ini. Jangan lupa laksanakan tugas sebelum pulang.`
          : `Perhatian. ${spokenNames}${more} belum tercatat dalam laporan piket hari ini. Harap segera menyelesaikan piket sebelum meninggalkan kelas.`;

        return {
          message,
          targets,
          mode
        };
      },

      async announceNow(shouldSpeak = true) {
        const out = await this.getAnnouncerMessage(true);
        this.setSpeechBox('announcer-teacher-preview', out.message, false);
        this.setSpeechBox('announcer-home-message', out.message, false);
        const pill = Util.el('announcer-missing-pill');
        if (pill) pill.textContent = out.targets.length ? `${out.targets.length} perlu diumumkan` : 'Semua aman';
        if (shouldSpeak) {
          const unlocked = this._speechUnlocked || await this.unlockSpeechFromGesture();
          if (!unlocked) {
            UI.toast('Suara belum diizinkan browser. Klik Umumkan sekali lagi dari halaman aktif.', 'warning');
            return { ...out, spoken:false };
          }
          const spoke = await this.speak(out.message, 'announcer-teacher-preview');
          if (spoke) {
            const now = Time.now();
            const { hour, minute } = this.timeParts(now);
            if (
              hour > this.announceHour ||
              (hour === this.announceHour && minute >= this.announceMinute)
            ) {
              const key = `${this.monthKey(now)}_${Time.dateKey(now)}`;
              Local.set(`${STORAGE.announcerSpokenPrefix}${key}`, '1');
            }
          }
        }
        return out;
      },

      syncAnnouncerUI() {
        const enabled = Local.get(STORAGE.announcerEnabled, '0') === '1';
        const btn = Util.el('btn-announcer-toggle');
        const pill = Util.el('announcer-status-pill');
        if (btn) {
          btn.setAttribute('aria-checked', String(enabled));
          btn.setAttribute('aria-label', enabled ? 'Matikan announcer otomatis' : 'Aktifkan announcer otomatis');
        }
        if (pill) {
          pill.innerHTML = enabled
            ? '<i aria-hidden="true" class="fa-solid fa-volume-high"></i> Announcer aktif · 14.50'
            : '<i aria-hidden="true" class="fa-solid fa-volume-xmark"></i> Announcer manual';
        }
      },

      async tickAnnouncer(forceDue = false) {
        if (this._announceInFlight) return;
        const enabled = Local.get(STORAGE.announcerEnabled, '0') === '1';
        if (!enabled) return;

        const now = Time.now();
        const { hour, minute } = this.timeParts(now);
        const isScheduledMinute = hour === this.announceHour && minute === this.announceMinute;
        const isPastScheduledMinute =
          hour > this.announceHour ||
          (hour === this.announceHour && minute > this.announceMinute);

        // Timer browser dapat terlambat ketika tab disuspend/background.
        // Hanya callback scheduler yang boleh memakai forceDue agar polling
        // 5 detik tidak membuat announcer berbicara segera setelah diaktifkan
        // pada sore hari.
        if (!isScheduledMinute && !(forceDue && isPastScheduledMinute)) return;

        const key = `${this.monthKey(now)}_${Time.dateKey(now)}`;
        const spokenKey = `${STORAGE.announcerSpokenPrefix}${key}`;
        if (Local.get(spokenKey, '0') === '1') return;

        this._announceInFlight = true;
        try {
          const out = await this.getAnnouncerMessage(true);
          this.setSpeechBox('announcer-teacher-preview', out.message, false);
          this.setSpeechBox('announcer-home-message', out.message, false);
            const pill = Util.el('announcer-missing-pill');
          if (pill) pill.textContent = out.targets.length ? `${out.targets.length} perlu diumumkan` : 'Semua aman';

          if (!this._speechUnlocked) {
            // Tidak memaksa suara di luar user gesture. Preview tetap diperbarui.
            // Peringatan hanya sekali per hari agar polling 5 detik tidak menjadi spam.
            if (this._permissionWarningKey !== key) {
              this._permissionWarningKey = key;
              this.syncAnnouncerUI();
              UI.toast('Waktu 14.50 tercapai, tetapi suara browser belum diaktifkan. Klik Umumkan untuk menjalankan suara.', 'warning');
            }
            return;
          }
          const spoke = await this.speak(out.message, 'announcer-teacher-preview');
          if (spoke) Local.set(spokenKey, '1');
        } finally {
          this._announceInFlight = false;
        }
      },

      scheduleNextAnnouncerCheck() {
        if (this._nextTimer) window.clearTimeout(this._nextTimer);
        const now = Time.now();
        const { hour, minute, second } = this.timeParts(now);
        const nowSeconds = (hour * 3600) + (minute * 60) + second;
        const targetSeconds = (this.announceHour * 3600) + (this.announceMinute * 60);
        let deltaSeconds = targetSeconds - nowSeconds;
        if (deltaSeconds <= 0) deltaSeconds += 24 * 60 * 60;
        const delay = Math.max(1000, deltaSeconds * 1000);
        this._nextTimer = window.setTimeout(() => {
          void this.tickAnnouncer(true);
          this.scheduleNextAnnouncerCheck();
        }, delay);
      },

      async refreshAll() {
        try {
          await this.announceNow(false);
          await this.tickAnnouncer();
        } catch (error) {
          console.warn('PiketAIFeatures.refreshAll:', error);
        }
      },
    };
    /* =========================================================
       APP UI
       ========================================================= */
    const App = {
      async init() {
        this.installGlobalGuards();
        this.installScrollPerformanceGuard();

        // UI performa disembunyikan dari pengguna, jadi konfigurasi lama yang pernah
        // dipilih manual harus kembali ke auto agar tier perangkat selalu dihitung
        // berdasarkan kemampuan aktual perangkat + runtime saat ini.
        if (Local.get(STORAGE.perfMode, 'auto') !== 'auto') {
          Local.set(STORAGE.perfMode, 'auto');
        }

        Performance.apply();
        void Performance.calibrateRuntime();
        Config.load();
        // Pasang semua event handler UI sebelum menunggu SDK cloud.
        // Supabase bersifat opsional dan lambatnya CDN tidak boleh membuat tombol
        // Ruang Guru, Setup, Kamera, atau pusat kontrol tampak mati.
        this.bindEvents();
        this.bindQuickCenter();
        this.watchSupabaseSdk();
        SmartDashboard.init();
        PiketAIFeatures.init();
        // Jangan blokir first-paint/UI ketika Supabase SDK belum siap atau gagal dimuat.
        // Jika SDK sudah tersedia sinkron, build client tetap dilakukan sekarang;
        // jika belum, watchSupabaseSdk() akan menangani event load secara lazy.
        if (window.supabase?.createClient) {
          await Cloud.buildClient();
        }
        const savedBrightness = Number(Local.get('piket_ui_brightness_v1', 75));
        const savedMotion = Number(Local.get('piket_motion_intensity_v1', 70));
        State.uiBrightness = Util.clamp(Number.isFinite(savedBrightness) ? savedBrightness : 75, 45, 100);
        State.motionIntensity = Util.clamp(Number.isFinite(savedMotion) ? savedMotion : 70, 0, 100);
        this.setQuickRange('brightness', State.uiBrightness, false);
        this.setQuickRange('motion', State.motionIntensity, false);
        Performance.applyMotion(State.performance?.mode || 'balanced');
        this.fillSetupForm();
        this.updateClock();
        setInterval(() => {
          if (document.visibilityState === 'visible') {
            this.updateClock();
          }
        }, 1000);
        this.updateOnlineBadge();
        void Connection.start();

        const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        motionQuery?.addEventListener?.('change', () => Performance.apply());
        window.addEventListener('piket:connectionchange', async event => {
          const status = event.detail?.status;
          this.updateOnlineBadge();
          this.updateQuickPanel();
          if (status !== 'online') {
            this.renderHome();
            return;
          }

          try {
            await Time.sync();
            await Reports.syncPendingDeletes();

            const syncResult =
              await Reports.syncPendingLocalReports();

            if (
              syncResult.synced > 0 &&
              syncResult.failed === 0
            ) {
              UI.toast(
                `${syncResult.synced} laporan lokal berhasil disinkronkan ke cloud.`,
                'success'
              );
            } else if (
              syncResult.synced > 0 &&
              syncResult.failed > 0
            ) {
              UI.toast(
                `${syncResult.synced} laporan berhasil disinkronkan; ` +
                `${syncResult.failed} laporan masih menunggu sinkronisasi.`,
                'warning'
              );
            } else if (syncResult.failed > 0) {
              UI.toast(
                `${syncResult.failed} laporan belum berhasil disinkronkan. ` +
                `Evidence lokal tetap dipertahankan.`,
                'warning'
              );
            }

            if (
              syncResult.synced > 0 &&
              State.currentPanel === 'teacher'
            ) {
              await this.renderTeacherPanel();
            }
          } catch (error) {
            console.warn('Online sync:', error);

            UI.toast(
              'Koneksi kembali tersedia, tetapi sinkronisasi laporan belum selesai. Coba refresh laporan atau tunggu koneksi stabil.',
              'warning'
            );
          } finally {
            this.renderHome();
          }
        });

        this.renderHome();
        this.navigate(State.config?.classId ? 'home' : 'setup');

        Time.sync().then(() => {
          if (!Time.isTrusted()) UI.toast(Cloud.ready() ? 'Waktu server belum tersedia. Draft tetap bisa dibuat, tetapi submit laporan dikunci sampai waktu tervalidasi.' : 'Waktu server belum tersedia. Laporan akan memakai jam perangkat (Mode Lokal).', 'warning');
          this.updateClock();
          this.renderHome();
        });
        setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          Time.sync()
            .then(() => { this.updateClock(); this.renderHome(); })
            .catch(error => console.warn('scheduled time sync:', error));
        }, 5 * 60 * 1000);

        if (Connection.isUsable() && Cloud.ready()) {
          Reports.syncPendingDeletes()
            .then(() => Reports.syncPendingLocalReports())
            .then(async initialSync => {
              if (initialSync.synced > 0) {
                UI.toast(`${initialSync.synced} laporan lokal disinkronkan ke cloud.`, 'success');
              }

              if (State.currentPanel === 'teacher') {
                await this.renderTeacherPanel();
              }
            })
            .catch(error => {
              console.warn('Initial cloud sync:', error);
            });
        }
      },
      installScrollPerformanceGuard() {
        if (this._scrollGuardInstalled) return;
        this._scrollGuardInstalled = true;

        const root = document.documentElement;
        let endTimer = 0;
        let frameId = 0;

        const markScrolling = () => {
          if (frameId) return;
          frameId = window.requestAnimationFrame(() => {
            frameId = 0;
            root.classList.add('is-scrolling');
            window.clearTimeout(endTimer);
            endTimer = window.setTimeout(() => {
              root.classList.remove('is-scrolling');
            }, 120);
          });
        };

        window.addEventListener('scroll', markScrolling, {
          passive: true
        });

        window.addEventListener('pagehide', () => {
          window.cancelAnimationFrame(frameId);
          window.clearTimeout(endTimer);
          root.classList.remove('is-scrolling');
        }, { once: true });
      },
      installGlobalGuards() {
        const iconStylesheet = Util.el('font-awesome-css');
        iconStylesheet?.addEventListener('error', () => {
          document.documentElement.classList.add('no-icons');
        }, { once:true });

        window.addEventListener('error', event => {
          // Resource error (ikon, gambar, CDN) tidak boleh dianggap sebagai
          // runtime exception dan memunculkan toast yang mengganggu pengguna.
          if (!event.error) {
            console.warn('Resource error:', event.message || event.target?.src || event.target?.href || event.target);
            return;
          }
          console.error('Runtime error:', event.error || event.message);
          UI.toast('Terjadi error non-fatal. Coba ulangi tindakan terakhir.', 'error');
        });
        window.addEventListener('unhandledrejection', event => {
          console.error('Unhandled promise:', event.reason);
          const reason = String(
            event.reason?.message ||
            event.reason ||
            ''
          );
          const recoverable =
            /AbortError|NetworkError|fetch failed|timeout/i.test(reason);

          if (!recoverable) return;

          event.preventDefault();
          UI.toast('Koneksi atau proses latar terganggu. Aplikasi tetap berjalan.', 'warning');
        });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) { Camera.stop(); return; }
          Time.sync()
            .then(() => this.updateClock())
            .catch(error => console.warn('visibility time sync:', error));
          PiketAIFeatures.invalidateAttendanceSnapshot?.();
          void PiketAIFeatures.tickAnnouncer(true);
          PiketAIFeatures.scheduleNextAnnouncerCheck();
          if (State.currentPanel === 'student' && !State.blobKondisi && !State.cameraStarting && !Util.el('camera-card')?.classList.contains('hidden')) Camera.start();
        });
      },
      bindEvents() {
        this.on('btn-back','click', () => this.navigate('home'));
        this.on('btn-nav-student','click', () => {
          if (!State.config) return this.navigate('setup');
          const members = Config.membersForToday();
          if (!DAYS.includes(Time.dayName()) || !members.length) {
            return UI.toast('Tidak ada jadwal anggota piket untuk hari ini.', 'warning');
          }
          if (!Limit.canSubmit()) return UI.toast('Laporan hari ini sudah dikirim dari perangkat ini.', 'warning');
          this.navigate('student');
        });
        this.on('btn-nav-teacher','click', async () => {
          if (!State.config) return this.navigate('setup');
          try { await SmartDashboard.openTeacherAccess(); } catch (error) {
            console.error('btn-nav-teacher:', error);
            UI.toast('Ruang Guru gagal dibuka. Coba lagi.', 'error');
          }
        });
        this.on('btn-nav-setup','click', () => this.navigate('setup'));
        this.on('form-setup','submit', (event) => { event.preventDefault(); this.saveSetup(); });
        this.on('btn-reset-setup','click', () => this.resetSetup());
        window.addEventListener('storage', event => {
          if (event.key?.startsWith(STORAGE.submittedPrefix) && event.newValue === null) {
            if (State.submittedTodayKey === event.key) {
              State.submittedTodayKey = null;
            }
            return;
          }

          if (event.key !== STORAGE.config) return;

          PiketAIFeatures.invalidateAttendanceSnapshot?.();
          const before = JSON.stringify(State.config || null);
          const next = Config.load();
          const after = JSON.stringify(next || null);

          // Abaikan event yang tidak mengubah konfigurasi efektif.
          if (before === after) return;

          if (!next?.classId) {
            State.submittedTodayKey = null;
            const oldSupabaseClient = State.supabaseClient;
            disposeSupabaseClient(oldSupabaseClient);
            State.supabaseClient = null;

            this.clearPhotoState();
            Camera.stop();

            if (State.currentPanel !== 'setup') {
              this.navigate('setup');
            } else {
              this.fillSetupForm();
            }

            UI.toast(
              'Data aplikasi telah direset dari tab lain.',
              'warning'
            );
            return;
          }

          // Konfigurasi berubah: jangan biarkan foto/sesi lama bercampur
          // dengan kelas atau backend baru.
          this.clearPhotoState();
          Camera.stop();

          void Cloud.buildClient();

          this.navigate('home');
          UI.toast(
            'Konfigurasi kelas diperbarui dari tab lain. Sesi foto lama dibersihkan agar data tidak tercampur.',
            'warning'
          );
        });
        this.on('btn-copy-group-template','click', () => this.applyGroupTemplate());
        this.on('btn-test-supabase','click', () => this.testSupabase());
        this.on('performance-mode','change', event => Performance.apply(event.target.value));
        const activatePhotoTab = target => {
          const changed = State.photoTarget !== target;
          Camera.setTarget(target);

          // setTarget() already updates detection/DeepAR. Reacquire hardware
          // only when no camera lifecycle is currently active.
          if (changed && !State.camStream && !State.deepAR) Camera.start();
        };
        this.on('btn-tab-anggota','click', () => activatePhotoTab('anggota'));
        this.on('btn-tab-kondisi','click', () => activatePhotoTab('kondisi'));
        this.on('btn-tab-anggota','keydown', event => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            Util.el('btn-tab-kondisi')?.focus();
            activatePhotoTab('kondisi');
          } else if (event.key === 'Home') {
            event.preventDefault();
            event.currentTarget?.focus();
            activatePhotoTab('anggota');
          } else if (event.key === 'End') {
            event.preventDefault();
            Util.el('btn-tab-kondisi')?.focus();
            activatePhotoTab('kondisi');
          }
        });
        this.on('btn-tab-kondisi','keydown', event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            Util.el('btn-tab-anggota')?.focus();
            activatePhotoTab('anggota');
          } else if (event.key === 'Home') {
            event.preventDefault();
            Util.el('btn-tab-anggota')?.focus();
            activatePhotoTab('anggota');
          } else if (event.key === 'End') {
            event.preventDefault();
            event.currentTarget?.focus();
            activatePhotoTab('kondisi');
          }
        });
        this.on('btn-switch-cam','click', () => Camera.switchCamera());
        this.on('btn-camera-retry','click', () => Camera.retry());
        this.on('btn-snap','click', () => Camera.snapshot());
        this.on('btn-retake','click', () => this.retake());
        this.on('btn-submit-report','click', () => this.submitReport());
        this.on('btn-save-draft','click', () => this.saveDraft());
        this.on('btn-refresh-reports','click', () => this.renderTeacherPanel());
        this.on('btn-confirm-delete','click', () => this.executeDeleteReport());
        this.on('btn-cancel-delete','click', () => this.closeDeleteModal());
        Util.el('delete-modal')?.addEventListener('click', event => { if (event.target.id === 'delete-modal') this.closeDeleteModal(); });
        Util.el('quick-control-center')?.addEventListener('close', () => {
          State.quickPanelOpen = false;
          const opener = Util.el('btn-control-center');
          opener?.setAttribute('aria-expanded','false');
          opener?.focus();
        });
        Util.el('delete-modal')?.addEventListener('close', () => { State.pendingDeleteId = null; });
        // beforeunload is attached dynamically by setUnsavedChangesGuard()
        // only while photo evidence is still held in memory.
      },
      watchSupabaseSdk() {
        const sdkScript = Util.el('supabase-sdk');
        if (!sdkScript || window.supabase?.createClient) return;
        if (sdkScript.dataset.readyWatcher === '1') return;

        sdkScript.dataset.readyWatcher = '1';
        sdkScript.addEventListener('load', async () => {
          if (!window.supabase?.createClient) return;

          try {
            await Cloud.buildClient();
            this.updateOnlineBadge();
            if (State.currentPanel === 'home') {
              this.renderHome();
            } else if (State.currentPanel === 'teacher') {
              await this.renderTeacherPanel();
            }

            if (Connection.isUsable() && State.config?.classId) {
              await Reports.syncPendingDeletes();
              await Reports.syncPendingLocalReports();
            }
          } catch (error) {
            console.warn('Supabase SDK late initialization:', error);
          }
        }, { once:true });
      },
      on(id, event, handler) { const el = Util.el(id); if (el) el.addEventListener(event, handler); },
      updateQuickPanel() {
        const online = Connection.isUsable();
        const dot = Util.el('quick-online-dot');
        const onlineValue = Util.el('quick-online-value');
        const cloudValue = Util.el('quick-cloud-value');
        const perfValue = Util.el('quick-performance-value');
        const perfNote = Util.el('quick-performance-note');
        const mode = Local.get(STORAGE.perfMode,'auto');
        const profile = Performance.profiles[State.performance?.mode || 'balanced'];
        dot?.classList.toggle('offline', !online);
        if (onlineValue) onlineValue.textContent = online ? 'Online' : 'Offline';
        if (cloudValue) cloudValue.textContent = Cloud.ready() ? 'Supabase aktif' : (State.config?.supabase?.url && !window.supabase?.createClient ? 'Supabase SDK gagal dimuat' : 'Penyimpanan Local');
        if (perfValue) perfValue.textContent = profile?.label || 'Seimbang';
        if (perfNote) perfNote.textContent = mode === 'auto' ? 'Mode otomatis' : 'Mode manual';
        this.setQuickRange('brightness', State.uiBrightness, false);
        this.setQuickRange('motion', State.motionIntensity, false);
      },
      setQuickRange(type, value, updateState=true) {
        const clamped = Util.clamp(Number(value) || 0, 0, 100);
        if (type === 'brightness') {
          if (updateState) State.uiBrightness = clamped;
          const fill = Util.el('quick-brightness-fill');
          const label = Util.el('quick-brightness-value');
          const input = Util.el('quick-brightness');
          if (fill) fill.style.setProperty('--fill', `${clamped}%`);
          if (label) label.textContent = `${Math.round(clamped)}%`;
          if (input) input.value = String(Math.round(clamped));
          document.documentElement.style.setProperty('--ui-brightness', String(0.82 + (clamped / 100) * 0.18));
        } else if (type === 'motion') {
          if (updateState) State.motionIntensity = clamped;
          const fill = Util.el('quick-motion-fill');
          const label = Util.el('quick-motion-value');
          const input = Util.el('quick-motion');
          if (fill) fill.style.setProperty('--fill', `${clamped}%`);
          if (label) label.textContent = `${Math.round(clamped)}%`;
          if (input) input.value = String(Math.round(clamped));
        }
      },
      openQuickPanel() {
        const panel = Util.el('quick-control-center');
        const sheet = panel?.querySelector('.quick-panel');
        if (!panel || panel.open) return;
        this.updateQuickPanel();
        try { panel.showModal(); } catch (_) { panel.setAttribute('open',''); }
        State.quickPanelOpen = true;
        Util.el('btn-control-center')?.setAttribute('aria-expanded','true');
        sheet?.classList.add('is-moving');
        panel.classList.add('is-moving');
        window.clearTimeout(this._quickMotionTimer);
        this._quickMotionTimer = window.setTimeout(() => {
          sheet?.classList.remove('is-moving');
          panel.classList.remove('is-moving');
        }, 280);
        requestAnimationFrame(() => Util.el('btn-close-control-center')?.focus());
      },
      closeQuickPanel() {
        const panel = Util.el('quick-control-center');
        const sheet = panel?.querySelector('.quick-panel');
        if (!panel) return;
        sheet?.classList.remove('is-moving');
        panel.classList.remove('is-moving');
        if (panel.open) panel.close();
        else panel.removeAttribute('open');
        State.quickPanelOpen = false;
        Util.el('btn-control-center')?.setAttribute('aria-expanded','false');
        Util.el('btn-control-center')?.focus();
      },
      toggleQuickPanel() {
        State.quickPanelOpen ? this.closeQuickPanel() : this.openQuickPanel();
      },
      bindQuickCenter() {
        this.on('btn-control-center','click', () => this.toggleQuickPanel());
        this.on('btn-close-control-center','click', () => this.closeQuickPanel());
        this.on('quick-student','click', () => { 
          this.closeQuickPanel(); 
          if (!State.config) return this.navigate('setup');
          const members = Config.membersForToday();
          if (!DAYS.includes(Time.dayName()) || !members.length) {
            return UI.toast('Tidak ada jadwal anggota piket untuk hari ini.', 'warning');
          }
          if (!Limit.canSubmit()) return UI.toast('Laporan hari ini sudah dikirim.', 'warning');
          this.navigate('student'); 
        });
        this.on('quick-teacher','click', async () => {
          this.closeQuickPanel();
          if (!State.config) return this.navigate('setup');
          try { await SmartDashboard.openTeacherAccess(); } catch (error) {
            console.error('quick-teacher:', error);
            UI.toast('Ruang Guru gagal dibuka. Coba lagi.', 'error');
          }
        });
        this.on('quick-setup','click', () => { this.closeQuickPanel(); this.navigate('setup'); });
        this.on('quick-brightness','input', event => {
          this.setQuickRange('brightness', event.target.value);
        });
        this.on('quick-brightness','change', () => {
          Local.set(
            'piket_ui_brightness_v1',
            String(State.uiBrightness)
          );
        });
        this.on('quick-motion','input', event => {
          const value = Number(event.target.value) || 0;
          this.setQuickRange('motion', value);
          Performance.applyMotion(State.performance?.mode || 'balanced');
        });
        this.on('quick-motion','change', () => {
          Local.set(
            'piket_motion_intensity_v1',
            String(State.motionIntensity)
          );
        });
        Util.el('quick-control-center')?.addEventListener('click', event => { if (event.target.id === 'quick-control-center') this.closeQuickPanel(); });
      },
      updateClock() {
        const clock = Util.el('realtime-clock');
        if (clock) clock.textContent = Time.clockText();
      },
      updateOnlineBadge() {
        Connection.render();
        const storage = Util.el('home-storage');
        if (storage) storage.textContent = Cloud.ready() && Connection.isUsable() ? 'Supabase' : 'Local';
        this.updateQuickPanel();
      },
      renderHome() {
        const day = Time.dayName();
        const members = Config.membersForToday();
        Util.el('home-day').textContent = day;
        Util.el('home-group-count').textContent = `${members.length} orang`;
        Util.el('home-teacher-name').textContent = `Wali Kelas: ${State.config?.teacherName || '-'}`;
        const status = Util.el('home-status');
        if (!State.config?.classId) UI.setStatus(status, 'Konfigurasi kelas belum lengkap.', 'warning');
        else if (members.length === 0) UI.setStatus(status, `Belum ada anggota piket untuk ${day}.`, 'warning');
        else if (!Time.isTrusted() && Cloud.ready()) UI.setStatus(status, `${Time.syncStatusText()} Pengiriman laporan dikunci sampai waktu tervalidasi.`, 'warning');
        else if (!Limit.canSubmit()) UI.setStatus(status, 'Laporan hari ini sudah dikirim dari perangkat ini.', 'success');
        else UI.setStatus(status, `Jadwal ${day} siap. ${members.length} anggota terdaftar.`, 'info');
        const studentButton = Util.el('btn-nav-student');
        const canStart = !!State.config?.classId && members.length > 0 && Limit.canSubmit();
        studentButton?.classList.toggle('btn-pulse', canStart && !document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced'));
        this.updateOnlineBadge();
        // Render analitik hanya jika dashboard sedang terlihat/terbuka.
        const dashboardAccordion = document.querySelector('.dashboard-accordion');
        if (dashboardAccordion?.open) void SmartDashboard.renderAll();
      },
      navigate(panelId) {
        const run = () => this._navigateCore(panelId);

        const motionDisabled =
          document.body.classList.contains('motion-low') ||
          document.body.classList.contains('motion-reduced');

        if (
          !motionDisabled &&
          State.currentPanel &&
          State.currentPanel !== panelId &&
          typeof document.startViewTransition === 'function'
        ) {
          try {
            return document.startViewTransition(run);
          } catch (error) {
            console.warn('View Transition fallback:', error);
          }
        }

        return run();
      },
      _navigateCore(panelId) {
        const target = Util.el(`panel-${panelId}`);
        if (!target) return;

        if (State.submitInFlight && panelId !== 'home') {
          return UI.toast(
            'Pengiriman laporan masih berlangsung. Tunggu hingga selesai.',
            'warning'
          );
        }

        if (
          State.currentPanel === 'student' &&
          panelId !== 'student' &&
          (State.blobAnggota instanceof Blob || State.blobKondisi instanceof Blob)
        ) {
          const leave = window.confirm(
            'Foto bukti yang belum dikirim akan dihapus jika meninggalkan halaman ini. Lanjutkan?'
          );
          if (!leave) return;
          this.clearPhotoState();
        }

        if (State.currentPanel === 'teacher' && panelId !== 'teacher') {
          this._renderToken = (this._renderToken || 0) + 1;
          if (Array.isArray(this._teacherObjectUrls)) {
            this._teacherObjectUrls.forEach(url => {
              try { URL.revokeObjectURL(url); } catch (_) {}
            });
          }
          this._teacherObjectUrls = [];
        }

        Camera.stop();
        Util.qsa('.panel').forEach(panel => { panel.hidden = true; });
        target.hidden = false;
        State.currentPanel = panelId;
        // Asisten Piket hanya tersedia di Ruang Guru agar tidak menutupi alur siswa.
        SmartDashboard.setChatAvailable(panelId === 'teacher');
        if (panelId === 'teacher') SmartDashboard.setChatOpen(true);
        UI.animatePanel(target);
        const back = Util.el('btn-back');
        const title = Util.el('header-title');
        const subtitle = Util.el('header-subtitle');
        if (panelId === 'home') {
          back.hidden = true; title.textContent = 'Piket AI'; subtitle.textContent = State.config?.classId || 'Auto Report'; this.renderHome();
        } else if (panelId === 'setup') {
          back.hidden = false; title.textContent = 'Pengaturan Kelas'; subtitle.textContent = State.config?.classId || 'Konfigurasi'; this.fillSetupForm();
        } else if (panelId === 'student') {
          back.hidden = false; title.textContent = 'Laporan Siswa'; subtitle.textContent = `${Time.dayName()} · ${State.config?.classId || '-'}`; this.renderStudent();
        } else if (panelId === 'teacher') {
          back.hidden = false; title.textContent = 'Ruang Guru'; subtitle.textContent = State.config?.classId || '-'; this.renderTeacherPanel();
        }
        window.scrollTo({ top:0, behavior:'auto' });
      },
      fillSetupForm() {
        const cfg = Config.normalize(State.config || {});
        Util.el('setup-class-id').value = cfg.classId;
        Util.el('setup-teacher-name').value = cfg.teacherName;
        Util.el('supabase-url').value = cfg.supabase.url;
        Util.el('supabase-key').value = cfg.supabase.key;
        Util.el('supabase-bucket').value = cfg.supabase.bucket;
        const root = Util.el('weekday-editor');
        root.innerHTML = '';
        DAYS.forEach(day => {
          const names = cfg.members[day] || [];
          const card = document.createElement('div');
          card.className = 'day-card';
          card.innerHTML = `
            <div class="day-head"><span class="day-name">${day}</span><span id="count-${day}" class="count-badge">${names.length}</span></div>
            <div class="day-body">
              <textarea id="members-${day}" name="members-${day}" aria-label="Anggota piket ${day}" placeholder="Nama siswa 1\nNama siswa 2\nNama siswa 3">${Util.escapeHTML(names.join('\n'))}</textarea>
            </div>`;
          root.appendChild(card);
          const area = Util.el(`members-${day}`);
          area.addEventListener('input', () => {
            const count = Config.normalizeMemberList(area.value).length;
            Util.el(`count-${day}`).textContent = count;
          });
        });
        Performance.apply();
        this.updateOnlineBadge();
      },
      readSetupForm() {
        const members = Config.defaultMembers();
        DAYS.forEach(day => {
          const area = Util.el(`members-${day}`);
          members[day] = Config.normalizeMemberList(area?.value || '');
        });
        return {
          classId: Util.el('setup-class-id').value.trim().replace(/\s+/g,''),
          teacherName: Util.el('setup-teacher-name').value.trim(),
          members,
          supabase: {
            url: Util.el('supabase-url').value.trim(),
            key: Util.el('supabase-key').value.trim(),
            bucket: Util.el('supabase-bucket').value.trim() || 'piket-foto'
          }
        };
      },
      async saveSetup() {
        if (State.submitInFlight || Reports.isBusy()) {
          return UI.toast('Tunggu proses laporan/sinkronisasi selesai sebelum mengubah pengaturan.', 'warning');
        }
        const form = this.readSetupForm();
        if (!form.classId || !form.teacherName) return UI.toast('ID kelas dan nama wali kelas wajib diisi.', 'error');

        if (Config.isUnsafeSupabaseKey(form.supabase.key)) {
          return UI.toast(
            'Jangan masukkan Supabase Secret/Service Role Key ke browser. Gunakan Publishable/Anon Key.',
            'error'
          );
        }

        const hasSupabaseUrl = Boolean(form.supabase.url);
        const hasSupabaseKey = Boolean(form.supabase.key);
        if (hasSupabaseUrl !== hasSupabaseKey) {
          return UI.toast(
            'Konfigurasi Supabase harus diisi lengkap: URL dan Publishable/Anon Key. Kosongkan keduanya untuk Mode Lokal.',
            'error'
          );
        }
        if (hasSupabaseUrl && !Cloud.canonicalOrigin(form.supabase.url)) {
          return UI.toast(
            'Supabase URL tidak valid. Gunakan URL proyek HTTPS yang benar.',
            'error'
          );
        }

        const button = Util.el('btn-save-setup');

        return Reports.withResetGate(async lock => {
          if (navigator.locks?.request && !lock) {
            return UI.toast(
              'Masih ada proses laporan/sinkronisasi aktif. Selesaikan proses tersebut sebelum mengubah pengaturan.',
              'warning'
            );
          }

          UI.setButtonBusy(button, true, 'Menyimpan…');
          try {
            const ok = Config.save(form);
            if (!ok) throw new Error('Pengaturan tidak bisa disimpan karena penyimpanan perangkat menolak akses.');
            Performance.apply();
            if (State.config?.supabase?.url && State.config?.supabase?.key && !State.supabaseClient) {
              await Cloud.buildClient();
            }
            UI.toast('Pengaturan kelas tersimpan.', 'success');
            this.renderHome();
            this.navigate('home');
          } catch (error) {
            UI.toast(error?.message || 'Pengaturan gagal disimpan.', 'error');
          } finally {
            UI.setButtonBusy(button, false);
          }
        }, {
          mode: 'exclusive',
          ifAvailable: true
        });
      },
      applyGroupTemplate() {
        const template = ['Nama Siswa 1','Nama Siswa 2','Nama Siswa 3'];
        DAYS.forEach(day => {
          const area = Util.el(`members-${day}`);
          if (area && !area.value.trim()) area.value = template.join('\n');
          area?.dispatchEvent(new Event('input'));
        });
        UI.toast('Template anggota dimasukkan hanya ke kolom yang masih kosong.', 'info');
      },
      async testSupabase() {
        const temp = this.readSetupForm();
        if (!temp.supabase.url || !temp.supabase.key) return UI.toast('Isi Supabase URL dan Anon Key terlebih dahulu.', 'warning');
        if (Config.isUnsafeSupabaseKey(temp.supabase.key)) {
          return UI.toast(
            'Jangan gunakan Supabase Secret/Service Role Key di browser.',
            'error'
          );
        }
        const status = Util.el('supabase-status');
        const button = Util.el('btn-test-supabase');
        const testConfig = Config.normalize({ ...(State.config || {}), supabase: temp.supabase });

        UI.setButtonBusy(button, true, 'Menguji…');
        UI.setStatus(status, 'Menguji koneksi…', 'info');
        try {
          const result = await Cloud.test(testConfig);
          UI.setStatus(status, result.message || 'Selesai.', result.ok ? 'success' : 'warning');
        } finally {
          UI.setButtonBusy(button, false);
        }
      },
      renderStudent() {
        this.clearPhotoState();
        const day = Time.dayName();
        const members = Config.membersForToday();
        Util.el('student-day-title').textContent = day;
        Util.el('student-day-subtitle').textContent = `Tanggal: ${Time.dateText()}`;
        const list = Util.el('student-checkboxes');
        list.innerHTML = '';
        const emptyBox = Util.el('student-members-empty');
        emptyBox.classList.toggle('hidden', members.length !== 0);
        emptyBox.textContent = DAYS.includes(day)
          ? 'Belum ada anggota untuk hari ini. Tambahkan anggota melalui Pengaturan Kelas.'
          : `Hari ${day} bukan hari piket (Senin–Jumat). Laporan hanya bisa dibuat pada hari kerja.`;
        if (!members.length) {
          Util.el('camera-card').classList.add('hidden');
          Util.el('camera-complete-box').classList.add('hidden');
          Util.el('btn-submit-report').disabled = true;
          Util.el('btn-submit-report')?.classList.remove('btn-pulse');
          this.updateStudentProgress(1);
          return;
        }
        const savedDraft = Local.getJSON(STORAGE.draft, null);
        const hasValidDraft = Boolean(
          savedDraft &&
          savedDraft.day === day &&
          savedDraft.dateKey === Time.dateKey() &&
          savedDraft.classId === State.config.classId &&
          Array.isArray(savedDraft.absents)
        );
        const draftedAbsents = hasValidDraft ? savedDraft.absents : [];

        members.forEach((name,index) => {
          const row = document.createElement('label');
          const isChecked = draftedAbsents.includes(name);
          row.className = `check-row${isChecked ? ' selected' : ''}`;
          row.innerHTML = `<span class="check-main"><span class="check-name">${Util.escapeHTML(name)}</span><span class="check-note">Centang jika tidak hadir</span></span><input class="ios-checkbox absent-checkbox" type="checkbox" value="${Util.escapeHTML(name)}" aria-label="${Util.escapeHTML(name)} tidak hadir" ${isChecked ? 'checked' : ''}>`;
          list.appendChild(row);
          const checkbox = row.querySelector('.absent-checkbox');
          checkbox?.addEventListener('change', () => {
            row.classList.toggle('selected', checkbox.checked);
            if (State.currentPanel === 'student' && State.photoTarget === 'anggota' && State.camStream) {
              if (Camera.requiresMemberFace()) {
                FaceDetection.start(Util.el('camera-stream'));
              } else {
                FaceDetection.stop();
                FaceDetection.badge('AI wajah: tidak diperlukan · semua anggota tidak hadir', '');
              }
            }
          });
        });
        if (hasValidDraft) {
          UI.toast('Draft terakhir dipulihkan.', 'info');
        }
        Util.el('camera-card').classList.remove('hidden');
        Util.el('camera-complete-box').classList.add('hidden');
        const submitButton = Util.el('btn-submit-report');
        submitButton.disabled = true;
        submitButton.classList.remove('btn-pulse');
        Util.el('ai-result').textContent = 'Menunggu dua foto selesai. Deteksi wajah anggota dilakukan lokal sebelum foto disimpan; pemeriksaan AI lanjutan tetap fail-safe dan tidak memblokir pengiriman.';
        Camera.setTarget('anggota');
        this.updateStudentProgress(1);
        setTimeout(() => { if (State.currentPanel === 'student' && !Util.el('camera-card')?.classList.contains('hidden')) Camera.start(); }, 60);
      },
      updateStudentProgress(step) {
        const map = {1:25,2:55,3:100};
        const percent = map[step] || 25;
        const progressBar = Util.el('student-progress-bar');
        if (progressBar) {
          progressBar.style.transform = `scaleX(${percent / 100})`;
          progressBar.setAttribute('aria-valuenow', String(percent));
          progressBar.classList.toggle('motion-progress', !document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced') && percent > 0 && percent < 100);
        }
        Util.el('student-step-label').textContent = `Langkah ${Math.min(step,3)} dari 3`;
        Util.el('student-step-percent').textContent = `${percent}%`;
      },
      getAbsents() {
        return Util.qsa('.absent-checkbox:checked').map(input => input.value);
      },
      clearPhotoState() {
        setUnsavedChangesGuard(false);
        State.aiRunToken++;
        State.aiController?.abort();
        State.aiController = null;
        State.blobAnggota = null; State.blobKondisi = null; State.aiAnalysis = null; State.photoTarget = 'anggota';
        if (State.urlAnggota) URL.revokeObjectURL(State.urlAnggota);
        if (State.urlKondisi) URL.revokeObjectURL(State.urlKondisi);
        State.urlAnggota = null; State.urlKondisi = null;
        Util.el('btn-submit-report')?.classList.remove('btn-pulse');
        ['thumb-anggota','thumb-kondisi'].forEach(id => { const img = Util.el(id); if (img) { img.src = EMPTY_IMAGE_SRC; img.alt = ''; img.setAttribute('aria-hidden','true'); img.style.display='none'; } });
        ['placeholder-anggota','placeholder-kondisi'].forEach(id => Util.el(id)?.classList.remove('hidden'));
      },
      retake() {
        if (State.submitInFlight) {
          return UI.toast(
            'Pengiriman laporan masih berlangsung. Tunggu hingga selesai.',
            'warning'
          );
        }

        this.clearPhotoState();
        Util.el('camera-card').classList.remove('hidden');
        Util.el('camera-complete-box').classList.add('hidden');
        const submitButton = Util.el('btn-submit-report');
        submitButton.disabled = true;
        submitButton.classList.remove('btn-pulse');
        Util.el('ai-result').textContent = 'Menunggu dua foto selesai. Deteksi wajah anggota dilakukan lokal sebelum foto disimpan; pemeriksaan AI lanjutan tetap fail-safe dan tidak memblokir pengiriman.';
        this.updateStudentProgress(1);
        Camera.setTarget('anggota');
        Camera.start();
      },
      submitReport() {
        // Derive the lock key from the same persisted config snapshot that
        // _submitReportCore() will submit with. This prevents a stale in-memory
        // State.config from causing two tabs to use different locks for one class.
        return Reports.withResetGate(() => {
          const persistedConfig = Config.load();
          const lockClassId = String(persistedConfig?.classId || 'global');
          const lockName = `piket-submit:${lockClassId}`;

          if (!navigator.locks?.request) {
            return this._submitReportCore();
          }

          return navigator.locks.request(
            lockName,
            { ifAvailable: true },
            async lock => {
              if (!lock) {
                return UI.toast(
                  'Pengiriman laporan sedang berlangsung di tab lain.',
                  'warning'
                );
              }

              return this._submitReportCore();
            }
          );
        });
      },
      async _submitReportCore() {
        const persistedConfig = Config.load();
        if (!persistedConfig?.classId) {
          State.submitInFlight = false;
          return UI.toast(
            'Konfigurasi aplikasi sudah direset. Silakan atur kembali kelas.',
            'warning'
          );
        }

        if (!State.blobAnggota || !State.blobKondisi) return UI.toast('Selesaikan dua foto terlebih dahulu.', 'warning');
        const btn = Util.el('btn-submit-report');
        if (State.submitInFlight) return;
        State.submitInFlight = true;

        if (!Time.isTrusted()) {
          UI.setButtonBusy(btn, true, 'Sinkron waktu…');
          try { await Time.sync(); } finally { UI.setButtonBusy(btn, false); }
          if (!Time.isTrusted()) {
            if (Cloud.ready()) {
              State.submitInFlight = false;
              return UI.toast('Waktu server belum tervalidasi. Hubungkan internet lalu coba kirim lagi.', 'error');
            }
            // Mode Lokal: tidak ada bukti cloud yang perlu divalidasi, jadi pakai jam perangkat.
            UI.toast('Waktu server tidak terjangkau. Laporan memakai jam perangkat (Mode Lokal).', 'warning');
          }
        }

        const submitClassId = String(persistedConfig.classId);
        const submitNow = Time.now();
        const submitDateKey = Time.dateKey(submitNow);
        const submitDay = Time.dayName(submitNow);
        const submitCreatedAt = Time.iso(submitNow);
        const blobAnggota = State.blobAnggota;
        const blobKondisi = State.blobKondisi;
        const aiAnalysis = State.aiAnalysis;
        if (!blobAnggota || !blobKondisi) {
          State.submitInFlight = false;
          return UI.toast(
            'Selesaikan dua foto terlebih dahulu.',
            'warning'
          );
        }
        const members = persistedConfig.members?.[submitDay] || [];

        if (!members.length) {
          State.submitInFlight = false;
          return UI.toast('Anggota piket hari ini belum diatur.', 'warning');
        }

        if (!Limit.canSubmit(submitClassId, submitDateKey)) {
          State.submitInFlight = false;
          return UI.toast('Laporan hari ini sudah dikirim dari perangkat ini.', 'warning');
        }

        if (!Connection.isUsable() && Cloud.ready()) {
          UI.toast('Tidak ada internet. Laporan akan disimpan secara lokal.', 'warning');
        }

        const cloudContext = Cloud.captureContext();
        UI.setButtonBusy(btn, true, 'Mengirim…');
        try {
          const reportId = Util.uid('report');
          const absents = this.getAbsents();
          const timeTrusted = Time.isTrusted();
          const timeSource = timeTrusted
            ? (State.timeSyncSource === 'server-stale' ? 'server-stale' : 'server')
            : 'device';

          const baseReport = {
            id: reportId,
            class_id: submitClassId,
            teacher_name: persistedConfig.teacherName,
            day: submitDay,
            date_key: submitDateKey,
            absents,
            present_count: Math.max(0, members.length - absents.length),
            total_members: members.length,
            ai_analysis: aiAnalysis,
            created_at: submitCreatedAt,
            time_source: timeSource,
            time_sync_source: State.timeSyncSource
          };


          let photoAnggota = {ok:false, skipped:true};
          let photoKondisi = {ok:false, skipped:true};
          let cloudSuccess = false;
          baseReport.photo_anggota_path = null;
          baseReport.photo_kondisi_path = null;

          if (cloudContext && Connection.isUsable()) {
            UI.setStatus(Util.el('ai-result'), 'Mengunggah foto ke Supabase…', 'info');
            try {
              [photoAnggota, photoKondisi] = await Promise.all([
                Cloud.uploadPhoto(blobAnggota, 'anggota', 'Foto anggota', submitDateKey, submitClassId, cloudContext),
                Cloud.uploadPhoto(blobKondisi, 'kondisi', 'Foto kelas', submitDateKey, submitClassId, cloudContext)
              ]);
              if (!photoAnggota.ok && !photoAnggota.skipped) throw new Error(photoAnggota.message || 'Upload foto anggota gagal.');
              if (!photoKondisi.ok && !photoKondisi.skipped) throw new Error(photoKondisi.message || 'Upload foto kelas gagal.');

              baseReport.photo_anggota_path = photoAnggota.path || null;
              baseReport.photo_kondisi_path = photoKondisi.path || null;
              const savedCloud = await Cloud.createReport(baseReport, cloudContext);
              if (!savedCloud.ok && !savedCloud.skipped) {
                const verify = await Cloud.readReportById(reportId, cloudContext);
                if (verify.ok && verify.data) {
                  const hasCompleteEvidence = await Cloud.hasCompleteEvidence(
                    verify.data,
                    cloudContext
                  );

                  if (!hasCompleteEvidence) {
                    throw new Error(
                      'Status laporan cloud belum dapat dipastikan. Row cloud belum memiliki kedua evidence foto; evidence lokal dipertahankan untuk rekonsiliasi.'
                    );
                  }

                  const verifiedPaths = new Set([
                    Cloud.photoPath(verify.data, 'anggota', cloudContext),
                    Cloud.photoPath(verify.data, 'kondisi', cloudContext)
                  ].filter(Boolean));
                  const cleanupPaths = [photoAnggota?.path, photoKondisi?.path]
                    .filter(Boolean)
                    .filter(path => !verifiedPaths.has(String(path)));
                  if (cleanupPaths.length) {
                    const cleanup = await Cloud.deleteStoragePaths(cleanupPaths, cloudContext);
                    if (!cleanup.ok) {
                      UI.toast(`Cloud sudah tersimpan, tetapi cleanup foto percobaan gagal: ${cleanup.message || 'unknown error'}.`, 'warning');
                    }
                  }
                  baseReport.photo_anggota_path = Cloud.photoPath(verify.data, 'anggota', cloudContext) || baseReport.photo_anggota_path;
                  baseReport.photo_kondisi_path = Cloud.photoPath(verify.data, 'kondisi', cloudContext) || baseReport.photo_kondisi_path;
                } else {
                  if (!verify.ok) {
                    throw new Error('Status laporan cloud belum dapat dipastikan. Foto cloud dipertahankan dan pengiriman dihentikan untuk mencegah duplikasi.');
                  }
                  throw new Error(savedCloud.message || 'Gagal menyimpan laporan ke Supabase.');
                }
              }
              cloudSuccess = true;
            } catch (cloudErr) {
              const uploadedPaths = [photoAnggota?.path, photoKondisi?.path].filter(Boolean);
              const cloudStatusUnknown = /Status laporan cloud belum dapat dipastikan/i.test(cloudErr?.message || '');
              if (uploadedPaths.length && !cloudStatusUnknown) {
                const cleanup = await Cloud.deleteStoragePaths(uploadedPaths, cloudContext);
                if (!cleanup.ok) {
                  UI.toast(`Cloud gagal dan cleanup foto sementara juga gagal: ${cleanup.message || 'unknown error'}.`, 'warning');
                }
              }
              if (cloudStatusUnknown) {
                UI.toast(
                  'Status laporan cloud belum dapat dipastikan. Laporan disimpan lokal untuk rekonsiliasi otomatis.',
                  'warning'
                );
                // Pertahankan URL foto cloud agar proses sync berikutnya
                // dapat mencoba merekonsiliasi row yang mungkin sudah tersimpan.
              } else {
                baseReport.photo_anggota_path = null;
                baseReport.photo_kondisi_path = null;
                UI.toast(`Cloud Error: ${cloudErr?.message || 'Gagal upload'}. Beralih ke penyimpanan lokal.`, 'warning');
              }
            }
          }

          const localReport = {
            ...baseReport,
            local_only: !cloudSuccess,
            _cloudOrigin: cloudContext?.url || null,
            _cloudBucket: cloudContext?.bucket || null
          };
          let localSaved = false;
          let localEvidenceSaved = true;

          if (!cloudSuccess) {
            localEvidenceSaved = await LocalMedia.saveReportPhotos(reportId, blobAnggota, blobKondisi);
            if (!localEvidenceSaved) {
              throw new Error('Koneksi cloud gagal dan foto tidak dapat disimpan di memori lokal. Laporan belum dianggap tersimpan.');
            }
            localSaved = await this.saveLocalReport(localReport);
            if (!localSaved) {
              await LocalMedia.deleteReportPhotos(reportId);
              throw new Error('Koneksi internet gagal dan memori browser penuh. Laporan tidak dapat disimpan dengan aman.');
            }
          } else {
            localSaved = await this.saveLocalReport(localReport);
          }

          const limitSaved = Limit.markSubmitted(
            submitClassId,
            submitDateKey
          );
          if (!limitSaved) {
            UI.toast('Laporan tersimpan, tetapi penanda batas harian gagal disimpan karena storage browser bermasalah. Jangan kirim ulang pada hari yang sama.', 'warning');
          }
          this.clearDraft();
          PiketAIFeatures.invalidateAttendanceSnapshot?.();
          const successMessage = cloudSuccess
            ? (localSaved
              ? 'Laporan piket berhasil dikirim dan tersimpan di cloud.'
              : 'Laporan piket berhasil dikirim ke cloud; cache lokal tidak dapat diperbarui.')
            : 'Laporan piket tersimpan di perangkat ini, termasuk foto.';
          UI.toast(successMessage, localEvidenceSaved && (cloudSuccess || localSaved) ? 'success' : 'warning');
          this.clearPhotoState();
          this.navigate('home');
          UI.showSuccess(successMessage);
        } catch (error) {
          console.error('submitReport:', error);
          UI.toast(error?.message || 'Laporan gagal dikirim.', 'error');
        } finally {
          State.submitInFlight = false;
          UI.setButtonBusy(btn, false);
        }
      },
      async saveLocalReport(report) {
        return Reports.addLocal(report);
      },
      saveDraft() {
        const draft = {
          classId: State.config?.classId || '',
          day: Time.dayName(),
          dateKey: Time.dateKey(),
          absents: this.getAbsents(),
          savedAt: Time.iso()
        };
        const ok = Local.setJSON(STORAGE.draft, draft);
        UI.toast(ok ? 'Draft kehadiran tersimpan di perangkat.' : 'Draft gagal disimpan.', ok ? 'success' : 'error');
      },
      clearDraft() { Local.remove(STORAGE.draft); },
      async renderTeacherPanel() {
        // Ruang Guru tidak lagi memakai gate autentikasi guru.
        const container = Util.el('reports-container');
        const empty = Util.el('reports-empty');
        if (!container) return;

        const token = this._renderToken = (this._renderToken || 0) + 1;
        const skeletonEnabled = !document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced');
        container.innerHTML = skeletonEnabled
          ? '<div class="card"><div class="skeleton" style="height:18px;width:42%;margin-bottom:10px"></div><div class="skeleton" style="height:12px;width:72%;margin-bottom:8px"></div><div class="skeleton" style="height:12px;width:58%"></div></div>'
          : '<div class="card"><div class="status info"><i aria-hidden="true" class="fa-solid fa-spinner fa-spin"></i> Memuat laporan…</div></div>';
        if (empty) empty.hidden = true;

        if (Array.isArray(this._teacherObjectUrls)) {
          this._teacherObjectUrls.forEach(url => { try { URL.revokeObjectURL(url); } catch (_) {} });
        }
        this._teacherObjectUrls = [];

        try {
          const classIdSnapshot = String(State.config?.classId || '');
          const reports = await Reports.list(classIdSnapshot);
          const reportList = Array.isArray(reports) ? reports : [];

          if (token !== this._renderToken || String(State.config?.classId || '') !== classIdSnapshot) return;

          this._localReportsCache = reportList;
          container.innerHTML = '';

          if (!reportList.length) {
            if (empty) empty.hidden = false;
            return;
          }

          const dateFormatter = new Intl.DateTimeFormat('id-ID', {
            timeZone: Time.zone,
            dateStyle: 'medium',
            timeStyle: 'short'
          });

          const localPhotoIds = reportList
            .filter(report => report?.local_only && (
              !Util.safeReportImageUrl(report.photo_anggota_url) ||
              !Util.safeReportImageUrl(report.photo_kondisi_url)
            ))
            .map(report => report.id);

          const localMediaMap = await LocalMedia.readReportPhotosBatch(localPhotoIds);
          if (token !== this._renderToken || String(State.config?.classId || '') !== classIdSnapshot) return;

          const cloudPhotoReports = reportList.filter(report => !report?.local_only);
          const signedPhotoMap = new Map();
          let signCursor = 0;
          const workerCount = Math.min(4, cloudPhotoReports.length);

          await Promise.all(Array.from({ length: workerCount }, async () => {
            while (true) {
              const index = signCursor++;
              if (index >= cloudPhotoReports.length) return;
              const report = cloudPhotoReports[index];
              const memberUrl = Util.safeReportImageUrl(report.photo_anggota_url);
              const conditionUrl = Util.safeReportImageUrl(report.photo_kondisi_url);
              const memberPath = Cloud.photoPath(report, 'anggota');
              const conditionPath = Cloud.photoPath(report, 'kondisi');

              const [signedMember, signedCondition] = await Promise.all([
                memberUrl || !memberPath ? Promise.resolve('') : Cloud.createSignedPhotoUrl(memberPath, 300),
                conditionUrl || !conditionPath ? Promise.resolve('') : Cloud.createSignedPhotoUrl(conditionPath, 300)
              ]);

              signedPhotoMap.set(String(report.id), {
                memberUrl: signedMember || memberUrl,
                conditionUrl: signedCondition || conditionUrl
              });
            }
          }));

          if (token !== this._renderToken || String(State.config?.classId || '') !== classIdSnapshot) return;

          for (const report of reportList) {
            const card = document.createElement('article');
            card.className = 'report-card';
            const absentText = Array.isArray(report.absents) && report.absents.length ? report.absents.join(', ') : 'Nihil';
            const createdAtMs = Date.parse(String(report.created_at || ''));
            const dateStr = Number.isFinite(createdAtMs) ? dateFormatter.format(new Date(createdAtMs)) : '-';

            let memberUrl = Util.safeReportImageUrl(report.photo_anggota_url);
            let conditionUrl = Util.safeReportImageUrl(report.photo_kondisi_url);

            if (!report.local_only) {
              const signed = signedPhotoMap.get(String(report.id));
              memberUrl = signed?.memberUrl || memberUrl;
              conditionUrl = signed?.conditionUrl || conditionUrl;
            }

            if (report.local_only && (!memberUrl || !conditionUrl)) {
              const media = localMediaMap.get(String(report.id)) || null;
              if (media?.anggota instanceof Blob) {
                memberUrl = URL.createObjectURL(media.anggota);
                this._teacherObjectUrls.push(memberUrl);
              }
              if (media?.kondisi instanceof Blob) {
                conditionUrl = URL.createObjectURL(media.kondisi);
                this._teacherObjectUrls.push(conditionUrl);
              }
            }

            const imageCards = [
              ['Anggota', memberUrl, 'Foto bukti anggota piket'],
              ['Kondisi kelas', conditionUrl, 'Foto bukti kondisi kelas']
            ].filter(item => item[1]).map(([label, url, alt]) => {
              const ratio = label === 'Anggota' ? '9 / 16' : '16 / 9';
              const ratioClass = label === 'Anggota' ? 'report-photo-portrait' : 'report-photo-landscape';
              return `
              <a href="${Util.escapeHTML(url)}" target="_blank" rel="noopener noreferrer" class="${ratioClass}" style="display:block;flex:1;min-width:0" aria-label="${Util.escapeHTML(label)} — buka foto penuh">
                <img src="${Util.escapeHTML(url)}" loading="lazy" decoding="async" style="width:100%;aspect-ratio:${ratio};object-fit:cover;border-radius:8px;border:1px solid var(--border);display:block" alt="${Util.escapeHTML(alt)}">
              </a>`;
            }).join('');

            const evidenceHtml = imageCards
              ? `<div style="display:flex;gap:8px;margin-top:12px;align-items:stretch">${imageCards}</div>`
              : report.local_only
                ? `<div class="status warning" style="margin-top:10px"><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> Foto aman tersimpan luring di perangkat pengirim dan menunggu sinkronisasi cloud.</div>`
                : `<div class="status info" style="margin-top:10px"><i class="fa-solid fa-image" aria-hidden="true"></i> Bukti foto tidak tersedia pada laporan ini.</div>`;

            card.innerHTML = `
              <div class="report-head">
                <div><div class="report-title">Hari ${Util.escapeHTML(report.day || '-')}</div><div class="report-date">${Util.escapeHTML(dateStr)}</div></div>
                <button class="icon-btn delete-report" type="button" aria-label="Hapus laporan"><i aria-hidden="true" class="fa-solid fa-trash-can"></i></button>
              </div>
              <div class="status info" style="margin-top:10px"><strong>Tidak hadir:</strong> ${Util.escapeHTML(absentText)}</div>
              ${evidenceHtml}
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
                <span class="chip">${Number(report.present_count || 0)} hadir</span>
                <span class="chip">${Number(report.total_members || 0)} anggota</span>
                <span class="chip">${report.local_only ? 'Lokal' : 'Cloud'}</span>
              </div>`;

            card.querySelector('.delete-report')?.addEventListener('click', () => this.triggerDelete(report.id));
            container.appendChild(card);
          }
        } catch (error) {
          console.error('Gagal menampilkan panel guru:', error);
          container.innerHTML = `<div class="status error"><i aria-hidden="true" class="fa-solid fa-triangle-exclamation"></i> Gagal memuat daftar laporan: ${Util.escapeHTML(error?.message || 'Kesalahan tidak dikenal.')}</div>`;
          if (empty) empty.hidden = true;
        }
      },
      triggerDelete(id) {
        State.pendingDeleteId = id;
        const modal = Util.el('delete-modal');
        if (!modal) return;
        if (!modal.open) {
          try { modal.showModal(); } catch (_) { modal.setAttribute('open',''); }
        }
        if (!document.body.classList.contains('motion-low') && !document.body.classList.contains('motion-reduced')) {
          modal.classList.remove('motion-modal');
          void modal.offsetWidth;
          modal.classList.add('motion-modal');
        }
      },
      closeDeleteModal() {
        State.pendingDeleteId = null;
        const modal = Util.el('delete-modal');
        if (!modal) return;
        if (modal.open) modal.close();
        else modal.removeAttribute('open');
        modal.classList.remove('motion-modal');
      },
      async executeDeleteReport() {
        const id = State.pendingDeleteId;
        if (!id) return;

        if (State.submitInFlight || Reports.isBusy()) {
          return UI.toast(
            'Tunggu proses laporan/sinkronisasi selesai sebelum menghapus.',
            'warning'
          );
        }

        State.pendingDeleteId = null;

        const deleteResult = await Reports.withResetGate(async () => {
          const result = await Reports.withReportMutationLock(id, async () => {
            const localReport = this.readLocalReport(id);
            if (!(await Reports.markDeleted(id))) {
              return {
                localReport,
                localDeleteReady:false,
                failed:true
              };
            }

            let localDeleteReady = false;
            const mediaDeleted = await LocalMedia.deleteReportPhotos(id);

            // Metadata lokal hanya dihapus setelah evidence lokal berhasil diproses.
            if (mediaDeleted) {
              localDeleteReady = await Reports.deleteLocal(id);
              if (!localDeleteReady) {
                UI.toast(
                  'Foto lokal sudah diproses, tetapi metadata laporan belum dapat dihapus. Penghapusan akan dicoba lagi.',
                  'warning'
                );
              }
            }

            return {
              localReport,
              localDeleteReady,
              failed:false
            };
          });

          if (result?.failed) return result;

          // Kita sudah berada di shared reset gate; hanya rekonsiliasi laporan
          // yang baru saja dihapus agar foreground delete tidak memproses antrean lain.
          await Reports.syncPendingDeletes({
            skipResetGate: true,
            onlyId: id
          });

          let localDeleteReady = Boolean(result?.localDeleteReady);
          if (!localDeleteReady) {
            localDeleteReady = !Reports.readLocal()
              .some(report => String(report.id) === String(id));
          }

          if (
            result?.localReport &&
            result.localReport.date_key === Time.dateKey() &&
            localDeleteReady
          ) {
            Limit.clearToday();
          }

          return {
            ...result,
            localDeleteReady
          };
        });

        if (deleteResult?.failed) {
          return UI.toast(
            'Penanda penghapusan gagal disimpan. Laporan belum dihapus.',
            'error'
          );
        }

        const { localReport } = deleteResult || {};
        const localDeleteReady = Boolean(deleteResult?.localDeleteReady);

        this.closeDeleteModal();
        PiketAIFeatures.invalidateAttendanceSnapshot?.();
        await this.renderTeacherPanel();

        const stillPending = Reports.readDeletedIds().has(String(id));
        if (stillPending) {
          UI.toast(
            (!Connection.isUsable() || !Cloud.ready())
              ? 'Laporan dihapus dari perangkat. Penghapusan cloud akan disinkronkan saat tersedia.'
              : 'Laporan dihapus dari perangkat, tetapi penghapusan cloud masih menunggu sinkronisasi.',
            'warning'
          );
        } else {
          UI.toast('Laporan dan foto cloud dihapus.', 'success');
        }
      },
      readLocalReport(id) {
        return this._localReportsCache?.find(report => String(report.id) === String(id)) || Reports.readLocal().find(report => String(report.id) === String(id)) || null;
      },
      async resetSetup() {
        if (State.submitInFlight || Reports.isBusy()) {
          return UI.toast('Tunggu proses laporan/sinkronisasi selesai sebelum mereset data.', 'warning');
        }
        const ok = window.confirm('Hapus konfigurasi, laporan, draft, dan pengaturan lokal?');
        if (!ok) return;

        return Reports.withResetGate(async lock => {
          if (navigator.locks?.request && !lock) {
            return UI.toast(
              'Masih ada proses laporan/sinkronisasi aktif di tab lain. Coba reset lagi.',
              'warning'
            );
          }

          this.clearPhotoState();
          Camera.stop();
          FaceDetection.dispose();

          const oldSupabaseClient = State.supabaseClient;
          const appDataCleared = Local.clearAppData();

          await DeepARCamera.shutdown();

          let mediaCleared = true;
          if (typeof LocalMedia !== 'undefined') {
            mediaCleared = await LocalMedia.clearAll();
          }

          const resetComplete = appDataCleared && mediaCleared;
          disposeSupabaseClient(oldSupabaseClient);
          State.config = null;
          State.submittedTodayKey = null;
          State.supabaseClient = null;
          State.uiBrightness = 75;
          State.motionIntensity = 70;
          this.setQuickRange('brightness', 75, false);
          this.setQuickRange('motion', 70, false);
          UI.toast(
            resetComplete
              ? 'Data lokal berhasil direset.'
              : 'Sebagian data lokal gagal dihapus. Coba reset lagi.',
            resetComplete ? 'success' : 'warning'
          );
          this.navigate('setup');
        }, {
          mode: 'exclusive',
          ifAvailable: true
        });
      }
    };

    window.App = App;
    window.PiketApp = App;

    // Inisialisasi hanya setelah DOM siap.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => App.init(), { once:true });
    } else {
      App.init();
    }
    window.addEventListener('DOMContentLoaded', () => {
      try { FaceDetection.selfCheck(); } catch (error) { console.warn('FaceDetection self-check runtime error:', error); }
    }, { once: true });

(() => {
      const get = id => document.getElementById(id);

      const syncAssistant = open => {
        const widget = get('smart-chat-widget');
        const button = get('btn-smart-chat-toggle');
        const body = get('smart-chat-body');
        const form = get('smart-chat-form');
        if (!widget || !button) return;

        const isOpen = Boolean(open);
        widget.classList.toggle('collapsed', !isOpen);
        widget.dataset.open = String(isOpen);
        if (body) body.hidden = !isOpen;
        if (form) form.hidden = !isOpen;
        button.setAttribute('aria-expanded', String(isOpen));
        button.setAttribute('aria-label', isOpen ? 'Minimalkan Asisten Piket' : 'Buka Asisten Piket');
        button.setAttribute('title', isOpen ? 'Turunkan Asisten Piket' : 'Buka Asisten Piket');
        button.innerHTML = isOpen
          ? '<i aria-hidden="true" class="fa-solid fa-chevron-down"></i>'
          : '<i aria-hidden="true" class="fa-solid fa-chevron-up"></i>';
      };

      const toggleAssistant = event => {
        event.preventDefault();
        event.stopPropagation();
        const widget = get('smart-chat-widget');
        if (!widget) return;
        syncAssistant(widget.classList.contains('collapsed'));
      };

      const bind = () => {
        const button = get('btn-smart-chat-toggle');
        const widget = get('smart-chat-widget');
        if (!button || !widget || button.dataset.assistantBound === '1') return;

        button.dataset.assistantBound = '1';
        button.addEventListener('click', toggleAssistant, { passive: false });
        button.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') toggleAssistant(event);
        }, { passive: false });
        syncAssistant(!widget.classList.contains('collapsed'));
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
      } else {
        bind();
      }
    })();
 
