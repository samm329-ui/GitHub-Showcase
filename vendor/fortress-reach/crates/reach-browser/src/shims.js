/* Environment profile injection.
 *
 * The script is installed with Page.addScriptToEvaluateOnNewDocument, so it
 * runs before any page script on every document of the session.
 *
 * Rules this file follows:
 *  1. Prefer the protocol. Anything the DevTools protocol can set is set
 *     there, because a protocol level override leaves no trace in the page.
 *     This file only covers what the protocol cannot express.
 *  2. Stay invisible. Overridden functions must look native: their name and
 *     their source text are produced by the native code path, and the
 *     overridden Function.prototype.toString reports the original source for
 *     every function the page itself defines.
 *  3. Stay consistent. The same surface must always produce the same value
 *     inside one session, and the different read paths of one surface must
 *     agree with each other, otherwise the disagreement itself becomes the
 *     signal.
 */
(() => {
  'use strict';

  const P = __PAYLOAD__;
  if (window.__reachProfileInstalled) return;
  window.__reachProfileInstalled = true;

  const nativeToString = Function.prototype.toString;

  /* ------------------------------------------------------------------ */
  /* Native looking helpers                                              */
  /* ------------------------------------------------------------------ */

  const registry = new WeakMap();

  function disguise(fn, name, source) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      registry.set(fn, source);
    } catch (e) {}
    return fn;
  }

  function fakeToString(name, source) {
    return function () { return source; };
  }

  // Replace Function.prototype.toString so that disguised functions report
  // native code, while every other function keeps reporting its real source.
  try {
    const patched = function toString() {
      const self = this;
      if (self === patched) {
        return 'function toString() { [native code] }';
      }
      if (self && (typeof self === 'function' || typeof self === 'object')) {
        const source = registry.get(self);
        if (source) return source;
      }
      try {
        return nativeToString.call(self);
      } catch (e) {
        return 'function () { [native code] }';
      }
    };
    Object.defineProperty(patched, 'toString', {
      value: fakeToString('toString', 'function toString() { [native code] }'),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Function.prototype, 'toString', {
      value: patched,
      configurable: true,
      writable: true,
    });
  } catch (e) {}

  function defGet(target, prop, getter, name, source) {
    try {
      disguise(getter, name || ('get ' + prop), source || ('function get ' + prop + '() { [native code] }'));
      Object.defineProperty(target, prop, {
        get: getter,
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
  }

  function defValue(target, prop, value) {
    try {
      Object.defineProperty(target, prop, {
        get: function () { return value; },
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
  }

  function safe(fn) {
    try { fn(); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Deterministic noise                                                 */
  /* ------------------------------------------------------------------ */

  function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function mix32(value) {
    value = (value ^ (value >>> 16)) >>> 0;
    value = Math.imul(value, 0x21f0aaad) >>> 0;
    value = (value ^ (value >>> 15)) >>> 0;
    value = Math.imul(value, 0x735a2d97) >>> 0;
    return (value ^ (value >>> 15)) >>> 0;
  }

  // The noise is keyed per site: a page sees a stable value for the whole
  // session, and two sessions never share one.
  const siteKey = fnv1a(String(P.noise.secret) + '|' + String(location.hostname || 'local'));
  const canvasSeed = mix32(siteKey ^ (P.noise.canvas >>> 0));
  const audioSeed = mix32(siteKey ^ (P.noise.audio >>> 0));

  function noiseAt(seed, x, y, channel) {
    let h = seed >>> 0;
    h = mix32(h ^ Math.imul(x | 0, 374761393));
    h = mix32(h ^ Math.imul(y | 0, 668265263));
    h = mix32(h ^ Math.imul(channel | 0, 2246822519));
    return h;
  }

  /* ------------------------------------------------------------------ */
  /* Navigator                                                           */
  /* ------------------------------------------------------------------ */

  const NavProto = window.Navigator && window.Navigator.prototype;

  if (NavProto) {
    // The launcher already clears the automation flag, so this only matters
    // when the session is attached to a browser that was started elsewhere.
    safe(() => {
      if (navigator.webdriver === true) {
        defGet(NavProto, 'webdriver', function () { return false; },
          'get webdriver', 'function get webdriver() { [native code] }');
      }
    });

    defGet(NavProto, 'languages', function () { return P.languages.slice(); },
      'get languages', 'function get languages() { [native code] }');

    defGet(NavProto, 'deviceMemory', function () { return P.hardware.deviceMemory; },
      'get deviceMemory', 'function get deviceMemory() { [native code] }');

    defGet(NavProto, 'hardwareConcurrency', function () { return P.hardware.hardwareConcurrency; },
      'get hardwareConcurrency', 'function get hardwareConcurrency() { [native code] }');

    defGet(NavProto, 'maxTouchPoints', function () { return 0; },
      'get maxTouchPoints', 'function get maxTouchPoints() { [native code] }');

    defGet(NavProto, 'vendor', function () { return 'Google Inc.'; },
      'get vendor', 'function get vendor() { [native code] }');

    defGet(NavProto, 'pdfViewerEnabled', function () { return true; },
      'get pdfViewerEnabled', 'function get pdfViewerEnabled() { [native code] }');

    // Network information.
    const connProto = window.NetworkInformation && window.NetworkInformation.prototype;
    if (connProto) {
      defGet(connProto, 'rtt', function () { return P.connection.rtt; },
        'get rtt', 'function get rtt() { [native code] }');
      defGet(connProto, 'downlink', function () { return P.connection.downlink; },
        'get downlink', 'function get downlink() { [native code] }');
      defGet(connProto, 'effectiveType', function () { return P.connection.effectiveType; },
        'get effectiveType', 'function get effectiveType() { [native code] }');
      defGet(connProto, 'saveData', function () { return P.connection.saveData; },
        'get saveData', 'function get saveData() { [native code] }');
      defGet(connProto, 'type', function () { return P.connection.effectiveType === '4g' ? 'wifi' : 'cellular'; },
        'get type', 'function get type() { [native code] }');
    }

    // Plugins and mime types.
    safe(() => {
      const pluginDefs = P.plugins;
      const mimeDefs = P.mimeTypes;

      const mimeObjects = mimeDefs.map(function (def) {
        const mime = Object.create(window.MimeType && window.MimeType.prototype || Object.prototype);
        try {
          Object.defineProperty(mime, 'type', { value: def.type, configurable: true, enumerable: true });
          Object.defineProperty(mime, 'suffixes', { value: def.suffixes, configurable: true, enumerable: true });
          Object.defineProperty(mime, 'description', { value: def.description, configurable: true, enumerable: true });
        } catch (e) {}
        return mime;
      });

      const pluginObjects = pluginDefs.map(function (def) {
        const plugin = Object.create(window.Plugin && window.Plugin.prototype || Object.prototype);
        try {
          Object.defineProperty(plugin, 'name', { value: def.name, configurable: true, enumerable: true });
          Object.defineProperty(plugin, 'filename', { value: def.filename, configurable: true, enumerable: true });
          Object.defineProperty(plugin, 'description', { value: def.description, configurable: true, enumerable: true });
          Object.defineProperty(plugin, 'length', { value: def.mimeTypes.length, configurable: true, enumerable: true });
          def.mimeTypes.forEach(function (mime, i) {
            Object.defineProperty(plugin, i, { value: mimeObjects[mime], configurable: true, enumerable: true });
          });
        } catch (e) {}
        return plugin;
      });

      const pluginArray = Object.create(window.PluginArray && window.PluginArray.prototype || Object.prototype);
      try {
        Object.defineProperty(pluginArray, 'length', { value: pluginObjects.length, configurable: true, enumerable: true });
        pluginObjects.forEach(function (plugin, i) {
          Object.defineProperty(pluginArray, i, { value: plugin, configurable: true, enumerable: true });
        });
        Object.defineProperty(pluginArray, 'item', {
          value: function (i) { return pluginObjects[i] || null; },
          configurable: true, writable: true,
        });
        Object.defineProperty(pluginArray, 'namedItem', {
          value: function (name) {
            for (let i = 0; i < pluginObjects.length; i++) {
              if (pluginObjects[i].name === name) return pluginObjects[i];
            }
            return null;
          },
          configurable: true, writable: true,
        });
        Object.defineProperty(pluginArray, 'refresh', {
          value: function () {},
          configurable: true, writable: true,
        });
      } catch (e) {}

      const mimeArray = Object.create(window.MimeTypeArray && window.MimeTypeArray.prototype || Object.prototype);
      try {
        Object.defineProperty(mimeArray, 'length', { value: mimeObjects.length, configurable: true, enumerable: true });
        mimeObjects.forEach(function (mime, i) {
          Object.defineProperty(mimeArray, i, { value: mime, configurable: true, enumerable: true });
        });
        Object.defineProperty(mimeArray, 'item', {
          value: function (i) { return mimeObjects[i] || null; },
          configurable: true, writable: true,
        });
        Object.defineProperty(mimeArray, 'namedItem', {
          value: function (name) {
            for (let i = 0; i < mimeObjects.length; i++) {
              if (mimeObjects[i].type === name) return mimeObjects[i];
            }
            return null;
          },
          configurable: true, writable: true,
        });
      } catch (e) {}

      defGet(NavProto, 'plugins', function () { return pluginArray; },
        'get plugins', 'function get plugins() { [native code] }');
      defGet(NavProto, 'mimeTypes', function () { return mimeArray; },
        'get mimeTypes', 'function get mimeTypes() { [native code] }');
    });

    // Permission queries are left alone. A browser that reports every
    // permission as granted, without a user gesture, is easy to tell apart
    // from one that was actually used.
  }

  /* ------------------------------------------------------------------ */
  /* Window                                                              */
  /* ------------------------------------------------------------------ */

  const WinProto = Object.getPrototypeOf(window);
  if (WinProto) {
    defGet(WinProto, 'outerWidth', function () { return P.display.outerWidth; },
      'get outerWidth', 'function get outerWidth() { [native code] }');
    defGet(WinProto, 'outerHeight', function () { return P.display.outerHeight; },
      'get outerHeight', 'function get outerHeight() { [native code] }');
  }

  // The window is the global object, so the attributes can live on the
  // instance as well as on the prototype.
  defGet(window, 'outerWidth', function () { return P.display.outerWidth; },
    'get outerWidth', 'function get outerWidth() { [native code] }');
  defGet(window, 'outerHeight', function () { return P.display.outerHeight; },
    'get outerHeight', 'function get outerHeight() { [native code] }');

  safe(() => {
    if (!window.chrome) {
      const chromeObject = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
          connect: function () {},
          sendMessage: function () {},
        },
        csi: function () { return {}; },
        loadTimes: function () { return {}; },
      };
      Object.defineProperty(window, 'chrome', {
        value: chromeObject, configurable: true, enumerable: true, writable: true,
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Screen                                                              */
  /* ------------------------------------------------------------------ */

  const ScreenProto = window.Screen && window.Screen.prototype;
  if (ScreenProto) {
    defGet(ScreenProto, 'width', function () { return P.display.width; },
      'get width', 'function get width() { [native code] }');
    defGet(ScreenProto, 'height', function () { return P.display.height; },
      'get height', 'function get height() { [native code] }');
    defGet(ScreenProto, 'availWidth', function () { return P.display.availWidth; },
      'get availWidth', 'function get availWidth() { [native code] }');
    defGet(ScreenProto, 'availHeight', function () { return P.display.availHeight; },
      'get availHeight', 'function get availHeight() { [native code] }');
    defGet(ScreenProto, 'colorDepth', function () { return P.display.colorDepth; },
      'get colorDepth', 'function get colorDepth() { [native code] }');
    defGet(ScreenProto, 'pixelDepth', function () { return P.display.colorDepth; },
      'get pixelDepth', 'function get pixelDepth() { [native code] }');
  }

  /* ------------------------------------------------------------------ */
  /* WebGL                                                               */
  /* ------------------------------------------------------------------ */

  safe(() => {
    const VENDOR = 37445;
    const RENDERER = 37446;
    const VERSION = 7938;
    const SHADING_LANGUAGE_VERSION = 35724;
    const MAX_TEXTURE_SIZE = 3379;
    const MAX_CUBE_MAP_TEXTURE_SIZE = 34076;
    const MAX_RENDERBUFFER_SIZE = 34024;
    const MAX_VIEWPORT_DIMS = 3386;
    const MAX_VERTEX_ATTRIBS = 34921;
    const MAX_VERTEX_UNIFORM_VECTORS = 35678;
    const MAX_VARYING_VECTORS = 35674;
    const MAX_FRAGMENT_UNIFORM_VECTORS = 35674;
    const MAX_COMBINED_TEXTURE_IMAGE_UNITS = 35681;
    const MAX_VERTEX_TEXTURE_IMAGE_UNITS = 35680;
    const MAX_TEXTURE_IMAGE_UNITS = 35682;

    const gl = P.webgl;

    const OVERRIDES = {};
    OVERRIDES[VENDOR] = gl.vendor;
    OVERRIDES[RENDERER] = gl.renderer;
    OVERRIDES[VERSION] = gl.version;
    OVERRIDES[SHADING_LANGUAGE_VERSION] = gl.shadingLanguageVersion;
    OVERRIDES[MAX_TEXTURE_SIZE] = gl.maxTextureSize;
    OVERRIDES[MAX_CUBE_MAP_TEXTURE_SIZE] = gl.maxCubeMapTextureSize;
    OVERRIDES[MAX_RENDERBUFFER_SIZE] = gl.maxRenderbufferSize;
    OVERRIDES[MAX_VERTEX_ATTRIBS] = 16;
    OVERRIDES[MAX_VERTEX_UNIFORM_VECTORS] = 4096;
    OVERRIDES[MAX_VARYING_VECTORS] = 30;
    OVERRIDES[MAX_FRAGMENT_UNIFORM_VECTORS] = 1024;
    OVERRIDES[MAX_COMBINED_TEXTURE_IMAGE_UNITS] = 32;
    OVERRIDES[MAX_VERTEX_TEXTURE_IMAGE_UNITS] = 16;
    OVERRIDES[MAX_TEXTURE_IMAGE_UNITS] = 16;

    function patchContext(proto, versionLabel, glslLabel) {
      if (!proto) return;
      const origGetParameter = proto.getParameter;
      const patchedGetParameter = function getParameter(parameter) {
        if (Object.prototype.hasOwnProperty.call(OVERRIDES, parameter)) {
          return OVERRIDES[parameter];
        }
        if (parameter === MAX_VIEWPORT_DIMS) {
          return gl.maxViewportDims;
        }
        return origGetParameter.call(this, parameter);
      };
      disguise(patchedGetParameter, 'getParameter', 'function getParameter() { [native code] }');
      Object.defineProperty(proto, 'getParameter', {
        value: patchedGetParameter, configurable: true, writable: true,
      });

      const origExtensions = proto.getSupportedExtensions;
      if (origExtensions) {
        const patchedExtensions = function getSupportedExtensions() {
          let list = [];
          try { list = origExtensions.call(this) || []; } catch (e) { list = []; }
          if (list.length > gl.extensionCount) list = list.slice(0, gl.extensionCount);
          return list;
        };
        disguise(patchedExtensions, 'getSupportedExtensions', 'function getSupportedExtensions() { [native code] }');
        Object.defineProperty(proto, 'getSupportedExtensions', {
          value: patchedExtensions, configurable: true, writable: true,
        });
      }
    }

    patchContext(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype,
      gl.version, gl.shadingLanguageVersion);
    patchContext(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype,
      gl.version2, gl.shadingLanguageVersion2);

    if (window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype) {
      const proto2 = window.WebGL2RenderingContext.prototype;
      const origGetParameter2 = proto2.getParameter;
      const patched2 = function getParameter(parameter) {
        if (Object.prototype.hasOwnProperty.call(OVERRIDES, parameter)) {
          return OVERRIDES[parameter];
        }
        if (parameter === MAX_VIEWPORT_DIMS) return gl.maxViewportDims;
        if (parameter === VERSION) return gl.version2;
        if (parameter === SHADING_LANGUAGE_VERSION) return gl.shadingLanguageVersion2;
        return origGetParameter2.call(this, parameter);
      };
      disguise(patched2, 'getParameter', 'function getParameter() { [native code] }');
      Object.defineProperty(proto2, 'getParameter', {
        value: patched2, configurable: true, writable: true,
      });
    }

    const ShaderPrecision = window.WebGLShaderPrecisionFormat && window.WebGLShaderPrecisionFormat.prototype;
    if (ShaderPrecision) {
      const orig = ShaderPrecision.constructor;
      void orig;
    }
    if (window.WebGLRenderingContext && window.WebGLRenderingContext.prototype.getShaderPrecisionFormat) {
      const proto = window.WebGLRenderingContext.prototype;
      const origPrecision = proto.getShaderPrecisionFormat;
      const patchedPrecision = function getShaderPrecisionFormat(shaderType, precisionType) {
        if (precisionType === 0x28B1 /* HIGH_FLOAT */) {
          const range = gl.precisionHighFloat;
          return {
            rangeMin: range[0], rangeMax: range[1], precision: range[2],
          };
        }
        return origPrecision.call(this, shaderType, precisionType);
      };
      disguise(patchedPrecision, 'getShaderPrecisionFormat', 'function getShaderPrecisionFormat() { [native code] }');
      Object.defineProperty(proto, 'getShaderPrecisionFormat', {
        value: patchedPrecision, configurable: true, writable: true,
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /* WebGPU                                                              */
  /* ------------------------------------------------------------------ */

  safe(() => {
    if (!navigator.gpu || !navigator.gpu.requestAdapter) return;
    const info = P.webgpu;
    const origRequestAdapter = navigator.gpu.requestAdapter;

    const limits = {
      maxTextureDimension1D: 8192,
      maxTextureDimension2D: 16384,
      maxTextureDimension3D: 2048,
      maxTextureArrayLayers: 256,
      maxBindGroups: 4,
      maxBindGroupsPlusVertexBuffers: 24,
      maxBindingsPerBindGroup: 1000,
      maxDynamicUniformBuffersPerPipelineLayout: 8,
      maxDynamicStorageBuffersPerPipelineLayout: 4,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      maxStorageBuffersPerShaderStage: 8,
      maxStorageTexturesPerShaderStage: 4,
      maxUniformBuffersPerShaderStage: 12,
      maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: 2147483644,
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
      maxVertexBuffers: 8,
      maxBufferSize: 268435456,
      maxVertexAttributes: 16,
      maxVertexBufferArrayStride: 2048,
      maxInterStageShaderComponents: 60,
      maxInterStageShaderVariables: 16,
      maxColorAttachments: 8,
      maxColorAttachmentBytesPerSample: 32,
      maxComputeWorkgroupStorageSize: 16384,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeWorkgroupsPerDimension: 65535,
    };

    const features = [
      'depth-clip-control',
      'depth32float-stencil8',
      'texture-compression-bc',
      'texture-compression-etc2',
      'timestamp-query',
      'indirect-first-instance',
    ];

    function syntheticAdapter() {
      const adapterInfo = {
        vendor: info.vendor,
        architecture: info.architecture,
        description: info.description,
        device: '',
        subgroupMinSize: info.subgroupMinSize,
        subgroupMaxSize: info.subgroupMaxSize,
      };

      const device = {
        features: new Set(features),
        limits: limits,
        lost: Promise.resolve({ reason: 'destroyed', message: '' }),
        queue: { onSubmittedWorkDone: function () { return Promise.resolve(); } },
        createBuffer: function () { throw new Error('The device was destroyed'); },
        destroy: function () {},
      };

      return {
        features: new Set(features),
        limits: limits,
        isFallbackAdapter: false,
        info: adapterInfo,
        requestDevice: function () { return Promise.resolve(device); },
      };
    }

    const patchedRequestAdapter = function requestAdapter() {
      const args = arguments;
      return origRequestAdapter.apply(this, args).then(function (adapter) {
        if (!adapter) return syntheticAdapter();

        const fakeInfo = {
          vendor: info.vendor,
          architecture: info.architecture,
          description: info.description,
          device: '',
          subgroupMinSize: info.subgroupMinSize,
          subgroupMaxSize: info.subgroupMaxSize,
        };
        return new Proxy(adapter, {
          get: function (target, prop) {
            if (prop === 'info') return fakeInfo;
            if (prop === 'isFallbackAdapter') return false;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }, function () {
        return syntheticAdapter();
      });
    };
    disguise(patchedRequestAdapter, 'requestAdapter', 'function requestAdapter() { [native code] }');
    Object.defineProperty(navigator.gpu, 'requestAdapter', {
      value: patchedRequestAdapter, configurable: true, writable: true,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Canvas                                                              */
  /* ------------------------------------------------------------------ */

  safe(() => {
    let bypass = false;

    function noiseImageData(imageData, originX, originY) {
      const data = imageData.data;
      const width = imageData.width;
      for (let i = 0; i < data.length; i += 4) {
        const pixel = i / 4;
        const x = originX + (pixel % width);
        const y = originY + Math.floor(pixel / width);
        const r = noiseAt(canvasSeed, x, y, 0);
        const g = noiseAt(canvasSeed, x, y, 1);
        const b = noiseAt(canvasSeed, x, y, 2);
        data[i] = Math.max(0, Math.min(255, data[i] + (r % 3) - 1));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + (g % 3) - 1));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (b % 3) - 1));
      }
      return imageData;
    }

    if (window.CanvasRenderingContext2D) {
      const proto = window.CanvasRenderingContext2D.prototype;
      const origGetImageData = proto.getImageData;
      const patchedGetImageData = function getImageData(x, y, width, height) {
        const result = origGetImageData.call(this, x, y, width, height);
        if (bypass) return result;
        return noiseImageData(result, x, y);
      };
      disguise(patchedGetImageData, 'getImageData', 'function getImageData() { [native code] }');
      Object.defineProperty(proto, 'getImageData', {
        value: patchedGetImageData, configurable: true, writable: true,
      });

      // Text metrics vary a little, but the variation has to be stable for
      // the same text in the same font.
      const metricsCache = new Map();
      const origMeasureText = proto.measureText;
      const patchedMeasureText = function measureText(text) {
        const metrics = origMeasureText.call(this, text);
        const font = this.font || '';
        const key = font + '|' + String(text);
        let delta = metricsCache.get(key);
        if (delta === undefined) {
          delta = (mix32(fnv1a(key) ^ canvasSeed) % 13 - 6) / 960;
          metricsCache.set(key, delta);
        }
        try {
          Object.defineProperty(metrics, 'width', {
            value: Math.max(0, metrics.width + delta), configurable: true,
          });
        } catch (e) {}
        return metrics;
      };
      disguise(patchedMeasureText, 'measureText', 'function measureText() { [native code] }');
      Object.defineProperty(proto, 'measureText', {
        value: patchedMeasureText, configurable: true, writable: true,
      });
    }

    if (window.HTMLCanvasElement) {
      const proto = window.HTMLCanvasElement.prototype;
      const origToDataURL = proto.toDataURL;

      function noisyCanvasCopy(source) {
        const off = document.createElement('canvas');
        off.width = source.width;
        off.height = source.height;
        const ctx = off.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(source, 0, 0);
        const original = window.CanvasRenderingContext2D.prototype.getImageData;
        const data = original.call(ctx, 0, 0, off.width, off.height);
        noiseImageData(data, 0, 0);
        ctx.putImageData(data, 0, 0);
        return off;
      }

      const patchedToDataURL = function toDataURL() {
        if (bypass) return origToDataURL.apply(this, arguments);
        bypass = true;
        try {
          const off = noisyCanvasCopy(this);
          if (!off) return origToDataURL.apply(this, arguments);
          return origToDataURL.apply(off, arguments);
        } catch (e) {
          return origToDataURL.apply(this, arguments);
        } finally {
          bypass = false;
        }
      };
      disguise(patchedToDataURL, 'toDataURL', 'function toDataURL() { [native code] }');
      Object.defineProperty(proto, 'toDataURL', {
        value: patchedToDataURL, configurable: true, writable: true,
      });

      if (proto.toBlob) {
        const origToBlob = proto.toBlob;
        const patchedToBlob = function toBlob(callback, type, quality) {
          if (bypass) return origToBlob.call(this, callback, type, quality);
          bypass = true;
          try {
            const off = noisyCanvasCopy(this);
            if (!off) return origToBlob.call(this, callback, type, quality);
            return origToBlob.call(off, callback, type, quality);
          } catch (e) {
            return origToBlob.call(this, callback, type, quality);
          } finally {
            bypass = false;
          }
        };
        disguise(patchedToBlob, 'toBlob', 'function toBlob() { [native code] }');
        Object.defineProperty(proto, 'toBlob', {
          value: patchedToBlob, configurable: true, writable: true,
        });
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Audio                                                               */
  /* ------------------------------------------------------------------ */

  safe(() => {
    if (!window.AudioBuffer) return;
    const proto = window.AudioBuffer.prototype;
    const origGetChannelData = proto.getChannelData;
    const patchedGetChannelData = function getChannelData(channel) {
      const data = origGetChannelData.call(this, channel);
      try {
        for (let i = 0; i < data.length; i++) {
          const hash = mix32(audioSeed ^ i);
          data[i] += ((hash % 2000) - 1000) * 1e-10;
        }
      } catch (e) {}
      return data;
    };
    disguise(patchedGetChannelData, 'getChannelData', 'function getChannelData() { [native code] }');
    Object.defineProperty(proto, 'getChannelData', {
      value: patchedGetChannelData, configurable: true, writable: true,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */

  safe(() => {
    if (!window.Element) return;
    const proto = window.Element.prototype;
    const ids = new WeakMap();
    let counter = 0;

    function elementId(element) {
      let id = ids.get(element);
      if (id === undefined) {
        id = ++counter;
        ids.set(element, id);
      }
      return id;
    }

    function jitterRect(rect, element) {
      const id = elementId(element);
      const jx = ((mix32(id ^ 0x51ed) % 21) - 10) / 1000;
      const jy = ((mix32(id ^ 0x9a3c) % 21) - 10) / 1000;
      try {
        Object.defineProperty(rect, 'x', { value: rect.x + jx, configurable: true });
        Object.defineProperty(rect, 'y', { value: rect.y + jy, configurable: true });
        Object.defineProperty(rect, 'width', { value: rect.width, configurable: true });
        Object.defineProperty(rect, 'height', { value: rect.height, configurable: true });
        Object.defineProperty(rect, 'top', { value: rect.top + jy, configurable: true });
        Object.defineProperty(rect, 'left', { value: rect.left + jx, configurable: true });
        Object.defineProperty(rect, 'right', { value: rect.right + jx, configurable: true });
        Object.defineProperty(rect, 'bottom', { value: rect.bottom + jy, configurable: true });
      } catch (e) {}
      return rect;
    }

    const origGetBounding = proto.getBoundingClientRect;
    const patchedGetBounding = function getBoundingClientRect() {
      const rect = origGetBounding.call(this);
      return jitterRect(rect, this);
    };
    disguise(patchedGetBounding, 'getBoundingClientRect', 'function getBoundingClientRect() { [native code] }');
    Object.defineProperty(proto, 'getBoundingClientRect', {
      value: patchedGetBounding, configurable: true, writable: true,
    });

    if (proto.getClientRects) {
      const origRects = proto.getClientRects;
      const patchedRects = function getClientRects() {
        const list = origRects.call(this);
        const rect = origGetBounding.call(this);
        const jittered = jitterRect(rect, this);
        const single = {
          x: jittered.x, y: jittered.y, width: jittered.width, height: jittered.height,
          top: jittered.top, left: jittered.left, right: jittered.right, bottom: jittered.bottom,
        };
        const fake = Object.create(window.DOMRectList && window.DOMRectList.prototype || Object.prototype);
        try {
          Object.defineProperty(fake, 'length', { value: 1, configurable: true });
          Object.defineProperty(fake, '0', { value: single, configurable: true, enumerable: true });
          Object.defineProperty(fake, 'item', {
            value: function (i) { return i === 0 ? single : null; },
            configurable: true, writable: true,
          });
        } catch (e) {}
        return fake;
      };
      disguise(patchedRects, 'getClientRects', 'function getClientRects() { [native code] }');
      Object.defineProperty(proto, 'getClientRects', {
        value: patchedRects, configurable: true, writable: true,
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Fonts, media devices, battery, keyboard, voices, storage           */
  /* ------------------------------------------------------------------ */

  safe(() => {
    if (window.FontFaceSet && document.fonts) {
      const proto = window.FontFaceSet.prototype;
      const origCheck = proto.check;
      const patchedCheck = function check(font) {
        const match = String(font).match(/["']?([^"']+?)["']?(?:\s*,|$)/);
        const family = match ? match[1].trim() : String(font).trim();
        if (family && P.fonts.indexOf(family) === -1) return false;
        return origCheck.call(this, font);
      };
      disguise(patchedCheck, 'check', 'function check() { [native code] }');
      Object.defineProperty(proto, 'check', {
        value: patchedCheck, configurable: true, writable: true,
      });
    }
  });

  safe(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const orig = navigator.mediaDevices.enumerateDevices;
    const patched = function enumerateDevices() {
      return Promise.resolve(P.mediaDevices.map(function (kind) {
        return { deviceId: '', kind: kind, label: '', groupId: '', toJSON: function () { return {}; } };
      }));
    };
    disguise(patched, 'enumerateDevices', 'function enumerateDevices() { [native code] }');
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      value: patched, configurable: true, writable: true,
    });
  });

  safe(() => {
    if (!navigator.getBattery) return;
    const orig = navigator.getBattery;
    const patched = function getBattery() {
      return Promise.resolve({
        charging: P.battery.charging,
        chargingTime: P.battery.charging ? P.battery.chargingTime : Infinity,
        dischargingTime: P.battery.charging ? Infinity : P.battery.dischargingTime,
        level: P.battery.level,
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () { return false; },
      });
    };
    disguise(patched, 'getBattery', 'function getBattery() { [native code] }');
    Object.defineProperty(navigator, 'getBattery', {
      value: patched, configurable: true, writable: true,
    });
  });

  safe(() => {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return;
    const orig = navigator.keyboard.getLayoutMap;
    const patched = function getLayoutMap() {
      const map = new Map();
      P.keyboard.forEach(function (pair) { map.set(pair[0], pair[1]); });
      return Promise.resolve(map);
    };
    disguise(patched, 'getLayoutMap', 'function getLayoutMap() { [native code] }');
    Object.defineProperty(navigator.keyboard, 'getLayoutMap', {
      value: patched, configurable: true, writable: true,
    });
  });

  safe(() => {
    if (!window.speechSynthesis) return;
    const orig = window.speechSynthesis.getVoices;
    const patched = function getVoices() {
      return P.voices.map(function (name) {
        return {
          voiceURI: name,
          name: name,
          lang: 'en-US',
          localService: true,
          default: name.indexOf('David') !== -1 || name === 'Alex',
        };
      });
    };
    disguise(patched, 'getVoices', 'function getVoices() { [native code] }');
    Object.defineProperty(window.speechSynthesis, 'getVoices', {
      value: patched, configurable: true, writable: true,
    });
  });

  safe(() => {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const orig = navigator.storage.estimate;
    const patched = function estimate() {
      return orig.call(this).then(function (result) {
        return { quota: P.storage.quota, usage: result && result.usage ? result.usage : 0 };
      });
    };
    disguise(patched, 'estimate', 'function estimate() { [native code] }');
    Object.defineProperty(navigator.storage, 'estimate', {
      value: patched, configurable: true, writable: true,
    });
  });
})();
