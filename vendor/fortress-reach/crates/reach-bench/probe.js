/* The environment probe.
 *
 * The same file is evaluated in every browser under comparison, so the
 * results can be compared field by field. The probe only reads; it never
 * changes the state of the page.
 */
(() => {
  const out = {};
  const pending = [];

  const take = (name, fn) => {
    try {
      const value = fn();
      out[name] = value === undefined ? null : value;
    } catch (e) {
      out[name] = 'error: ' + (e && e.message ? e.message : String(e));
    }
  };

  const takeAsync = (name, fn) => {
    pending.push(
      Promise.resolve()
        .then(fn)
        .then(
          (value) => { out[name] = value === undefined ? null : value; },
          (e) => { out[name] = 'error: ' + (e && e.message ? e.message : String(e)); }
        )
    );
  };

  /* --- identity ----------------------------------------------------- */

  take('userAgent', () => navigator.userAgent);
  take('platform', () => navigator.platform);
  take('vendor', () => navigator.vendor);
  take('appVersion', () => navigator.appVersion);
  take('webdriver', () => navigator.webdriver);
  take('pdfViewerEnabled', () => navigator.pdfViewerEnabled);
  take('oscpu', () => navigator.oscpu === undefined ? null : navigator.oscpu);
  take('languages', () => Array.from(navigator.languages || []));
  take('language', () => navigator.language);
  take('hardwareConcurrency', () => navigator.hardwareConcurrency);
  take('deviceMemory', () => navigator.deviceMemory);
  take('maxTouchPoints', () => navigator.maxTouchPoints);
  take('cookieEnabled', () => navigator.cookieEnabled);
  take('doNotTrack', () => navigator.doNotTrack);

  takeAsync('userAgentData', () => {
    const data = navigator.userAgentData;
    if (!data) return null;
    return {
      brands: data.brands,
      mobile: data.mobile,
      platform: data.platform,
    };
  });

  /* --- plugins and mime types --------------------------------------- */

  take('plugins', () => {
    const list = navigator.plugins;
    if (!list) return null;
    return {
      length: list.length,
      names: Array.from(list).map((p) => p.name),
      isArray: Array.isArray(list),
      constructor: list.constructor ? list.constructor.name : null,
    };
  });

  take('mimeTypes', () => {
    const list = navigator.mimeTypes;
    if (!list) return null;
    return { length: list.length, types: Array.from(list).map((m) => m.type) };
  });

  /* --- window and screen -------------------------------------------- */

  take('windowSize', () => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenX: window.screenX,
    screenY: window.screenY,
  }));

  take('screen', () => ({
    width: screen.width,
    height: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
    pixelDepth: screen.pixelDepth,
    availLeft: screen.availLeft,
    availTop: screen.availTop,
  }));

  take('mediaQueries', () => ({
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    prefersLight: window.matchMedia('(prefers-color-scheme: light)').matches,
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    colorGamutSrgb: window.matchMedia('(color-gamut: srgb)').matches,
    colorGamutP3: window.matchMedia('(color-gamut: p3)').matches,
    dynamicRangeHigh: window.matchMedia('(dynamic-range: high)').matches,
    forcedColors: window.matchMedia('(forced-colors: active)').matches,
    anyPointerCoarse: window.matchMedia('(any-pointer: coarse)').matches,
    anyHover: window.matchMedia('(any-hover: hover)').matches,
  }));

  /* --- locale -------------------------------------------------------- */

  take('locale', () => ({
    resolvedOptions: (() => {
      try { return Intl.DateTimeFormat().resolvedOptions(); } catch (e) { return null; }
    })(),
    timezone: (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; }
    })(),
    dateString: (() => {
      try { return new Date().toString(); } catch (e) { return null; }
    })(),
    offset: new Date().getTimezoneOffset(),
  }));

  /* --- webgl --------------------------------------------------------- */

  const glProbe = (label, Ctor) => {
    if (!Ctor) return null;
    let canvas;
    try { canvas = document.createElement('canvas'); } catch (e) { return null; }
    let gl = null;
    try { gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl'); } catch (e) { gl = null; }
    if (!gl) return { available: false };

    let extensions = [];
    try { extensions = gl.getSupportedExtensions() || []; } catch (e) { extensions = []; }

    let precision = null;
    try {
      const p = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      precision = { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision };
    } catch (e) { precision = null; }

    return {
      available: true,
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      unmaskedVendor: (() => {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
      })(),
      unmaskedRenderer: (() => {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
      })(),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
      maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
      maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
      maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
      extensionCount: extensions.length,
      extensionSample: extensions.slice(0, 6),
      precisionHighFloat: precision,
    };
  };

  take('webgl1', () => glProbe('webgl1', window.WebGLRenderingContext));
  take('webgl2', () => glProbe('webgl2', window.WebGL2RenderingContext));

  /* --- webgpu -------------------------------------------------------- */

  takeAsync('webgpu', () => {
    if (!navigator.gpu) return null;
    return navigator.gpu.requestAdapter().then((adapter) => {
      if (!adapter) return null;
      const info = adapter.info || (adapter.requestAdapterInfo ? null : null);
      return {
        vendor: info ? info.vendor : null,
        architecture: info ? info.architecture : null,
        description: info ? info.description : null,
        isFallbackAdapter: adapter.isFallbackAdapter === undefined ? null : adapter.isFallbackAdapter,
        features: adapter.features ? Array.from(adapter.features).slice(0, 10) : null,
        limits: adapter.limits
          ? {
              maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
              maxBufferSize: adapter.limits.maxBufferSize,
              maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
            }
          : null,
      };
    });
  });

  /* --- canvas -------------------------------------------------------- */

  take('canvas', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 120;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#123456';
    ctx.fillRect(10, 10, 120, 60);
    ctx.fillStyle = '#abcdef';
    ctx.fillRect(40, 20, 90, 40);
    const image = ctx.getImageData(0, 0, 240, 120);
    let hash = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      hash = (hash * 31 + image.data[i] + image.data[i + 1] * 3 + image.data[i + 2] * 7) | 0;
    }
    const dataUrl = canvas.toDataURL();
    const second = ctx.getImageData(0, 0, 240, 120);
    let hash2 = 0;
    for (let i = 0; i < second.data.length; i += 4) {
      hash2 = (hash2 * 31 + second.data[i] + second.data[i + 1] * 3 + second.data[i + 2] * 7) | 0;
    }
    const metrics = ctx.measureText('Fortress Reach 12345');
    return {
      hash: hash,
      hashSecondRead: hash2,
      stable: hash === hash2,
      dataUrlLength: dataUrl.length,
      dataUrlPrefix: dataUrl.slice(0, 32),
      textWidth: metrics.width,
      textWidthFractional: metrics.width % 1 !== 0,
    };
  });

  /* --- audio --------------------------------------------------------- */

  takeAsync('audio', () => {
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctor) return null;
    const context = new Ctor(1, 44100, 44100);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 10000;
    const compressor = context.createDynamicsCompressor();
    oscillator.connect(compressor);
    compressor.connect(context.destination);
    oscillator.start(0);
    return context.startRendering().then((buffer) => {
      const data = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
      return {
        sampleSum: Number(sum.toFixed(6)),
        length: data.length,
        sampleRate: context.sampleRate,
        baseLatency: context.baseLatency === undefined ? null : context.baseLatency,
        outputLatency: context.outputLatency === undefined ? null : context.outputLatency,
      };
    });
  });

  /* --- storage, permissions, devices -------------------------------- */

  takeAsync('storage', () => {
    if (!navigator.storage) return null;
    return navigator.storage.estimate().then((e) => ({ quota: e.quota, usage: e.usage }));
  });

  take('permissions', () => ({
    notification: window.Notification ? Notification.permission : null,
    geolocation: 'unknown',
  }));

  takeAsync('mediaDevices', () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
    return navigator.mediaDevices.enumerateDevices().then((devices) =>
      devices.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId }))
    );
  });

  takeAsync('battery', () => {
    if (!navigator.getBattery) return null;
    return navigator.getBattery().then((b) => ({
      charging: b.charging,
      level: b.level,
      chargingTime: b.chargingTime,
      dischargingTime: b.dischargingTime,
    }));
  });

  takeAsync('keyboard', () => {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return null;
    return navigator.keyboard.getLayoutMap().then((map) => ({
      size: map.size,
      sample: Array.from(map.entries()).slice(0, 5),
    }));
  });

  take('voices', () => {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    return { count: voices.length, names: voices.map((v) => v.name).slice(0, 6) };
  });

  /* --- network ------------------------------------------------------- */

  take('connection', () => {
    const c = navigator.connection;
    if (!c) return null;
    return {
      rtt: c.rtt,
      downlink: c.downlink,
      effectiveType: c.effectiveType,
      saveData: c.saveData,
      type: c.type,
    };
  });

  take('chromeObject', () => {
    if (!window.chrome) return null;
    return {
      present: true,
      hasRuntime: !!window.chrome.runtime,
      runtimeKeys: window.chrome.runtime ? Object.keys(window.chrome.runtime).length : 0,
      hasCsi: typeof window.chrome.csi === 'function',
      hasLoadTimes: typeof window.chrome.loadTimes === 'function',
    };
  });

  take('features', () => ({
    touchEvent: 'ontouchstart' in window,
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    webdriverFlag: navigator.webdriver,
    pdfViewer: typeof window.PDFViewerApplication !== 'undefined',
  }));

  take('stackFormat', () => {
    try {
      const error = new Error('probe');
      return (error.stack || '').split('\n')[1] || '';
    } catch (e) {
      return null;
    }
  });

  take('functionSource', () => {
    try {
      return Function.prototype.toString.call(function probe() {});
    } catch (e) {
      return null;
    }
  });

  /* --- the promise based probes ------------------------------------- */

  takeAsync('userAgentDataHigh', () => {
    const data = navigator.userAgentData;
    if (!data || !data.getHighEntropyValues) return null;
    return data.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64']);
  });

  return Promise.all(pending).then(() => out);
})();
