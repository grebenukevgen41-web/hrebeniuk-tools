/* ============================================================
   PS Hrebeniuk Tools – main.js  v1.20.0
   ============================================================
   Fixes:
   - Load Images + Replace Renders: delegate to installed JSX via AdobeScriptAutomation Scripts
   - fitLayerToCanvas: non-fatal (try/catch per-image so group ops still run)
   - getLayerBounds: try bounds / Bnd  / flat format fallbacks
   - collectArtLayers: use l.layers check instead of l.isGroup (UXP DOM compat)
   v1.20.0:
   - Batch Export path v3 → v4
   - PS 27.x fix: openPath/openExternal FIRST (AdobeScriptAutomation exe.execute() silently
     fails on PS 27.x security policy), removed JSX launch strategy
   ============================================================ */

'use strict';

var psModule, psCore, psAction, psApp;
try {
  psModule  = require('photoshop');
  psCore    = psModule.core;
  psAction  = psModule.action;
  psApp     = psModule.app;
} catch (e) { console.error('PS module load error:', e); }

var uxp = require('uxp');
var lfs = uxp.storage.localFileSystem;

// ── Status ───────────────────────────────────────────────────
function setStatus(text, cls) {
  var el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}
function clearStatus() { setTimeout(function () { setStatus('\u2014', ''); }, 4000); }

function withButton(btnId, fn) {
  return async function () {
    var btn = document.getElementById(btnId);
    if (btn && / busy/.test(btn.className)) return;           // уже виконується
    if (btn) btn.className += ' busy';
    try { await fn(); } finally { if (btn) btn.className = btn.className.replace(/ busy/g, ''); }
  };
}

// ── batchPlay shortcut ───────────────────────────────────────
async function bp(cmds) {
  return psAction.batchPlay(cmds, { synchronousExecution: true });
}

// ── Image filter ─────────────────────────────────────────────
var IMG_EXTS = ['jpg','jpeg','png','tif','tiff'];
function isImage(name) { return IMG_EXTS.indexOf(name.split('.').pop().toLowerCase()) !== -1; }
function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }

// ── Get sorted image entries ──────────────────────────────────
async function getImageEntries(folder) {
  var entries = await folder.getEntries();
  var imgs = entries.filter(function(e) { return e.isFile && isImage(e.name); });
  var withMeta = await Promise.all(imgs.map(async function(e) {
    var t = 0;
    try { var m = await e.getMetadata(); t = m.ctime ? new Date(m.ctime).getTime() : 0; } catch(_) {}
    return { entry: e, t: t };
  }));
  withMeta.sort(function(a,b) { return a.t - b.t; });
  return withMeta.map(function(x) { return x.entry; });
}

// ── Get value from batchPlay unit object or number ───────────
function val(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'object' && '_value' in x) return x._value;
  return 0;
}

// ── Get document dimensions via batchPlay ────────────────────
async function getDocSize(docId) {
  var r = await bp([{
    _obj: 'get',
    _target: [{ _ref: 'document', _id: docId }],
    _options: { dialogOptions: 'dontDisplay' }
  }]);
  return {
    w: val(r[0].width),
    h: val(r[0].height)
  };
}

// ── Get active layer bounds via batchPlay ────────────────────
async function getLayerBounds() {
  var r = await bp([{
    _obj: 'get',
    _target: [
      { _ref: 'property', _property: 'bounds' },
      { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
    ],
    _options: { dialogOptions: 'dontDisplay' }
  }]);
  var res = r[0];
  // Try nested object (bounds or legacy 'Bnd ')
  var b = res.bounds || res['Bnd '];
  if (b) {
    return { top: val(b.top), left: val(b.left), right: val(b.right), bottom: val(b.bottom) };
  }
  // Try flat format (top/left/right/bottom directly on descriptor)
  if (res.top != null && res.left != null) {
    return { top: val(res.top), left: val(res.left), right: val(res.right), bottom: val(res.bottom) };
  }
  throw new Error('bounds not found, keys: ' + Object.keys(res).join(','));
}

// ── Get layer info by ID ─────────────────────────────────────
async function getLayerInfo(layerId) {
  var r = await bp([{
    _obj: 'get',
    _target: [{ _ref: 'layer', _id: layerId }],
    _options: { dialogOptions: 'dontDisplay' }
  }]);
  return r[0];
}

// ── Place file as layer (token -> placeEvent -> rasterize) ───
async function placeToken(token) {
  await bp([{
    _obj: 'placeEvent',
    null: { _path: token, _kind: 'local' },
    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
    _options: { dialogOptions: 'dontDisplay' }
  }]);
  await bp([{
    _obj: 'rasterizeLayer',
    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
    _options: { dialogOptions: 'dontDisplay' }
  }]);
}

// ── Rename active layer ───────────────────────────────────────
async function renameLayer(name) {
  await bp([{
    _obj: 'set',
    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
    to: { _obj: 'layer', name: name }
  }]);
}

// ── Fit active layer to canvas via batchPlay ─────────────────
async function fitLayerToCanvas(docId) {
  var docSize = await getDocSize(docId);
  var canvasW = docSize.w;
  var canvasH = docSize.h;
  if (!canvasW || !canvasH) return;

  var b = await getLayerBounds();
  var lw = b.right - b.left;
  var lh = b.bottom - b.top;
  if (lw <= 0 || lh <= 0) return;

  var scale = Math.min(canvasW / lw, canvasH / lh) * 100;
  if (Math.abs(scale - 100) > 0.01) {
    await bp([{
      _obj: 'transform',
      _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
      freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
      interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubic' },
      width:  { _unit: 'percentUnit', _value: scale },
      height: { _unit: 'percentUnit', _value: scale },
      _options: { dialogOptions: 'dontDisplay' }
    }]);
    b = await getLayerBounds();
    lw = b.right - b.left;
    lh = b.bottom - b.top;
  }

  var dx = (canvasW - lw) / 2 - b.left;
  var dy = (canvasH - lh) / 2 - b.top;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    await bp([{
      _obj: 'move',
      _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
      to: { _obj: 'offset',
        horizontal: { _unit: 'pixelsUnit', _value: dx },
        vertical:   { _unit: 'pixelsUnit', _value: dy }
      },
      _options: { dialogOptions: 'dontDisplay' }
    }]);
  }
}

// ── Collapse all groups ───────────────────────────────────────
async function collapseAllGroups() {
  try { await bp([{ _obj: 'collapseAllGroupsEvent' }]); } catch(_) {}
}

// ── Select layer by ID ───────────────────────────────────────
async function selectLayer(layerId) {
  await bp([{
    _obj: 'select',
    _target: [{ _ref: 'layer', _id: layerId }],
    makeVisible: false,
    _options: { dialogOptions: 'dontDisplay' }
  }]);
}

// ── Get active layer ID ──────────────────────────────────────
async function getActiveLayerId() {
  var r = await bp([{
    _obj: 'get',
    _target: [
      { _ref: 'property', _property: 'layerID' },
      { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
    ],
    _options: { dialogOptions: 'dontDisplay' }
  }]);
  return r[0].layerID;
}

// ── Collect art layers recursively (from UXP DOM, OUTSIDE modal) ──
// In UXP PS DOM, groups have .layers (array); regular layers don't.
function collectArtLayers(layers) {
  var result = [];
  for (var i = 0; i < layers.length; i++) {
    var l = layers[i];
    if (l.layers) {
      // It's a group — recurse into children
      result = result.concat(collectArtLayers(l.layers));
    } else {
      result.push(l);
    }
  }
  return result;
}

// ── Move layer into group (after place, if needed) ───────────
// After placeEvent on a selected layer, the new layer goes ABOVE the selected layer.
// If the target was inside a group, the new layer should also be inside that group.
// This function checks and moves if placeEvent put the layer outside.
async function moveLayerAfterInGroup(newLayerId, targetLayerId) {
  // Get info about old layer to find its parent
  try {
    var targetInfo = await getLayerInfo(targetLayerId);
    var newInfo    = await getLayerInfo(newLayerId);
    // If both have same parentLayerID, they're in the same group -- OK
    // If different, move new layer into the group
    var targetParent = targetInfo.parentLayerID;
    var newParent    = newInfo.parentLayerID;
    if (targetParent && targetParent !== newParent) {
      // Move new layer to just above the old target layer
      await bp([{
        _obj: 'move',
        _target: [{ _ref: 'layer', _id: newLayerId }],
        to: { _ref: 'layer', _id: targetLayerId },
        adjustment: false,
        _options: { dialogOptions: 'dontDisplay' }
      }]);
    }
  } catch(e) {
    console.log('moveLayerAfterInGroup:', e.message);
  }
}


// ═══════════════════════════════════════════════════════════════
//  FILE PICKER — список файлів з галочками (що саме вантажити)
// ═══════════════════════════════════════════════════════════════
function onlyJsx(names) {
  return '$.global.__ONLY = {' + names.map(function (n) { return JSON.stringify(n) + ':1'; }).join(',') + '};\n';
}

// ═══════════════════════════════════════════════════════════════
//  LOAD IMAGES  — delegates to installed load_images.jsx via AdobeScriptAutomation
// ═══════════════════════════════════════════════════════════════
async function handleLoadImages() {
  if (!psApp || psApp.documents.length === 0) { setStatus('Vidkryj PSD!', 'err'); return; }

  // Вікно вибору ФАЙЛІВ: видно зображення, вибираєш потрібні (Ctrl/Shift+клік, Ctrl+A — усі)
  setStatus('Vyberi fajly...', '');
  var picked, folderPath;
  try {
    var files = await lfs.getFileForOpening({ allowMultiple: true, types: ['*'] });   // усі файли одразу, без вибору формату
    if (!files) { setStatus('—', ''); return; }
    if (!Array.isArray(files)) files = Array.from ? Array.from(files) : [files];
    files = files.filter(function (f) { return isImage(f.name); });
    if (files.length === 0) { setStatus('Nemaye zobrazhen', 'err'); return; }
    picked = files.map(function (f) { return f.name; });
    folderPath = (files[0].nativePath || '').replace(/\\/g, '/').replace(/\/[^\/]*$/, '');
  } catch (pe) { setStatus('ERR: ' + (pe.message || pe), 'err'); return; }
  if (!folderPath) { setStatus('ERR: no path', 'err'); return; }

  setStatus('Running JSX...', '');
  try {
    var dataFolder = await lfs.getDataFolder();
    var wrapperFile = await dataFolder.createFile('load_images_run.jsx', { overwrite: true });
    var jsxContent =
      onlyJsx(picked) +
      '$.global.__FOLDER = new Folder("' + folderPath.replace(/"/g, '\\"') + '");\n' +
      'var jsxFile = new File($.getenv("APPDATA") + "\\\\HrebeniukTools\\\\jsx\\\\load_images.jsx");\n' +
      'if (jsxFile.exists) { $.evalFile(jsxFile); }\n' +
      'else { alert("load_images.jsx not found:\\n" + jsxFile.fsName); }\n';
    await wrapperFile.write(jsxContent);
    var token = lfs.createSessionToken(wrapperFile);

    await psCore.executeAsModal(async function() {
      await bp([{
        _obj: 'AdobeScriptAutomation Scripts',
        javaScript: { _path: token, _kind: 'local' },
        javaScriptMessage: 'load_images',
        _options: { dialogOptions: 'dontDisplay' }
      }]);
    }, { commandName: 'Load Images' });

    setStatus('Done', 'ok');
    clearStatus();
  } catch(e) {
    setStatus('ERR: ' + (e.message || e), 'err');
  }
}

// ═══════════════════════════════════════════════════════════════
//  REPLACE RENDERS  — delegates to installed replace_renders.jsx via AdobeScriptAutomation
// ═══════════════════════════════════════════════════════════════
async function handleReplaceRenders() {
  if (!psApp || psApp.documents.length === 0) { setStatus('Vidkryj PSD!', 'err'); return; }

  setStatus('Vyberi papku...', '');
  var folder = await lfs.getFolder();
  if (!folder) { setStatus('\u2014', ''); return; }

  var folderPath = (folder.nativePath || '').replace(/\\/g, '/');
  if (!folderPath) { setStatus('ERR: no path', 'err'); return; }

  var doRename  = document.getElementById('chkRename').checked;
  var findVal   = doRename ? document.getElementById('txtFind').value : '';
  var replaceVal = doRename ? document.getElementById('txtReplace').value : '';
  if (doRename && !findVal) { setStatus('Zapovny pole Znajty', 'err'); return; }

  setStatus('Running JSX...', '');
  try {
    var dataFolder = await lfs.getDataFolder();
    var wrapperFile = await dataFolder.createFile('replace_renders_run.jsx', { overwrite: true });
    var jsxContent =
      '$.global.__FOLDER = new Folder("' + folderPath.replace(/"/g, '\\"') + '");\n' +
      '$.global.__UXP_AUTO_CONFIRM = true;\n' +
      '$.global.__RENAME_OPTIONS_PROVIDED = true;\n' +
      '$.global.__RENAME_FIND = "' + findVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '";\n' +
      '$.global.__RENAME_REPLACE = "' + replaceVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '";\n' +
      'var jsxFile = new File($.getenv("APPDATA") + "\\\\HrebeniukTools\\\\jsx\\\\replace_renders.jsx");\n' +
      'if (jsxFile.exists) { $.evalFile(jsxFile); }\n' +
      'else { alert("replace_renders.jsx not found:\\n" + jsxFile.fsName); }\n';
    await wrapperFile.write(jsxContent);
    var token = lfs.createSessionToken(wrapperFile);

    await psCore.executeAsModal(async function() {
      await bp([{
        _obj: 'AdobeScriptAutomation Scripts',
        javaScript: { _path: token, _kind: 'local' },
        javaScriptMessage: 'replace_renders',
        _options: { dialogOptions: 'dontDisplay' }
      }]);
    }, { commandName: 'Replace Renders' });

    setStatus('Done', 'ok');
    clearStatus();
  } catch(e) {
    setStatus('ERR: ' + (e.message || e), 'err');
  }
}

// ═══════════════════════════════════════════════════════════════
//  REPLACE MASKS  — delegates to installed replace_masks.jsx via AdobeScriptAutomation
// ═══════════════════════════════════════════════════════════════
async function handleReplaceMasks() {
  if (!psApp || psApp.documents.length === 0) { setStatus('Vidkryj PSD!', 'err'); return; }

  // Вікно вибору ФАЙЛІВ: видно зображення, вибираєш потрібні (Ctrl/Shift+клік, Ctrl+A — усі)
  setStatus('Vyberi fajly...', '');
  var picked, folderPath;
  try {
    var files = await lfs.getFileForOpening({ allowMultiple: true, types: ['*'] });   // усі файли одразу, без вибору формату
    if (!files) { setStatus('—', ''); return; }
    if (!Array.isArray(files)) files = Array.from ? Array.from(files) : [files];
    files = files.filter(function (f) { return isImage(f.name); });
    if (files.length === 0) { setStatus('Nemaye zobrazhen', 'err'); return; }
    picked = files.map(function (f) { return f.name; });
    folderPath = (files[0].nativePath || '').replace(/\\/g, '/').replace(/\/[^\/]*$/, '');
  } catch (pe) { setStatus('ERR: ' + (pe.message || pe), 'err'); return; }
  if (!folderPath) { setStatus('ERR: no path', 'err'); return; }

  setStatus('Running JSX...', '');
  try {
    var dataFolder = await lfs.getDataFolder();
    var wrapperFile = await dataFolder.createFile('replace_masks_run.jsx', { overwrite: true });
    var jsxContent =
      onlyJsx(picked) +
      '$.global.__FOLDER = new Folder("' + folderPath.replace(/"/g, '\\"') + '");\n' +
      '$.global.__UXP_AUTO_CONFIRM = true;\n' +
      'var jsxFile = new File($.getenv("APPDATA") + "\\\\HrebeniukTools\\\\jsx\\\\replace_masks.jsx");\n' +
      'if (jsxFile.exists) { $.evalFile(jsxFile); }\n' +
      'else { alert("replace_masks.jsx not found:\\n" + jsxFile.fsName); }\n';
    await wrapperFile.write(jsxContent);
    var token = lfs.createSessionToken(wrapperFile);

    await psCore.executeAsModal(async function() {
      await bp([{
        _obj: 'AdobeScriptAutomation Scripts',
        javaScript: { _path: token, _kind: 'local' },
        javaScriptMessage: 'replace_masks',
        _options: { dialogOptions: 'dontDisplay' }
      }]);
    }, { commandName: 'Update Masks' });

    setStatus('Done', 'ok');
    clearStatus();
  } catch(e) {
    setStatus('ERR: ' + (e.message || e), 'err');
  }
}

// ═══════════════════════════════════════════════════════════════
//  BATCH EXPORT
// ═══════════════════════════════════════════════════════════════
async function handleBatchExport() {
  var appdata = '';
  try { appdata = process.env.APPDATA || ''; } catch(_) {}
  var exePath = appdata + '\\PSBatchExportV5\\PS Batch Export v5.exe';

  // ── Strategy 1: pstools:// custom protocol (registered by install.bat) ───
  if (uxp.shell && typeof uxp.shell.openExternal === 'function') {
    try {
      await uxp.shell.openExternal('pstools://');
      setStatus('Launched', 'ok'); clearStatus(); return;
    } catch(e) { console.log('pstools:// failed:', e.message); }
  }

  // ── Strategy 2: doScript with temp JSX file ──────────────────
  var jsxLaunched = false;
  try {
    var dataFolder = await lfs.getDataFolder();
    var jsxFile = await dataFolder.createFile('launch_batch.jsx', { overwrite: true });
    var jsxContent =
      'var exePath = $.getenv("APPDATA") + "\\\\PSBatchExportV5\\\\PS Batch Export v5.exe";\n' +
      'var exe = new File(exePath);\n' +
      'if (exe.exists) { exe.execute(); }\n' +
      'else { alert("PS Batch Export v5 not found.\\nPath: " + exePath); }\n';
    await jsxFile.write(jsxContent);
    var jsxToken = lfs.createSessionToken(jsxFile);
    await psCore.executeAsModal(async function() {
      await bp([{
        _obj: 'AdobeScriptAutomation Scripts',
        javaScript: { _path: jsxToken, _kind: 'local' },
        javaScriptMessage: 'launch_batch',
        _options: { dialogOptions: 'dontDisplay' }
      }]);
    }, { commandName: 'Batch Export' });
    jsxLaunched = true;
    setStatus('Launched', 'ok'); clearStatus();
  } catch(e) { console.log('JSX launch failed:', e.message); }

  if (jsxLaunched) return;

  // ── Strategy 3: openPath ─────────────────────────────────────
  if (uxp.shell && typeof uxp.shell.openPath === 'function') {
    try {
      await uxp.shell.openPath(exePath);
      setStatus('Launched', 'ok'); clearStatus(); return;
    } catch(e) { console.log('openPath:', e.message); }
  }

  // ── Fallback: show path ──────────────────────────────────────
  try { await psCore.showAlert({ message: 'Launch manually:\n' + exePath }); } catch(_) {}
  setStatus('Launch manually', '');
}

// ═══════════════════════════════════════════════════════════════
//  PART MASKS  — delegates to installed part_masks.jsx
// ═══════════════════════════════════════════════════════════════
function pmFuzz() {
  var fuzz = parseInt(document.getElementById('pmFuzz').value, 10);
  if (isNaN(fuzz) || fuzz < 0) fuzz = 12;
  if (fuzz > 200) fuzz = 200;
  return fuzz;
}

// Запуск part_masks.jsx з дією (extra — додатковий JSX-рядок з параметрами)
async function runPartMasks(action, extra) {
  var dataFolder = await lfs.getDataFolder();
  var wrapperFile = await dataFolder.createFile('part_masks_run.jsx', { overwrite: true });
  var jsxContent =
    '$.global.__PM_ACTION = "' + action + '";\n' +
    '$.global.__PM_FUZZ = ' + pmFuzz() + ';\n' +
    '$.global.__PM_AUTO = false;\n' +
    '$.global.__PM_STATE_PATH = "' + (dataFolder.nativePath + '/pm_state.json').replace(/\\/g, '/') + '";\n' +
    (extra || '') +
    'var jsxFile = new File($.getenv("APPDATA") + "\\\\HrebeniukTools\\\\jsx\\\\part_masks.jsx");\n' +
    'if (jsxFile.exists) { $.evalFile(jsxFile); }\n' +
    'else { alert("part_masks.jsx not found:\\n" + jsxFile.fsName); }\n';
  await wrapperFile.write(jsxContent);
  var token = lfs.createSessionToken(wrapperFile);
  await psCore.executeAsModal(async function() {
    await bp([{
      _obj: 'AdobeScriptAutomation Scripts',
      javaScript: { _path: token, _kind: 'local' },
      javaScriptMessage: 'part_masks',
      _options: { dialogOptions: 'dontDisplay' }
    }]);
  }, { commandName: 'Part Masks' });
}

function handlePartMasks(action) {
  return async function () {
    if (!psApp || psApp.documents.length === 0) { setStatus('Vidkryj PSD!', 'err'); return; }
    try {
      await runPartMasks(action, '');
      setStatus('Done', 'ok');
      clearStatus();
    } catch(e) {
      setStatus('ERR: ' + (e.message || e), 'err');
    }
  };
}

// ── Вибір маски: маска + піпетка + палітра. Кожен клік по деталі — додати/прибрати її з маски ──
var pmPicking = false, pmBusy = false, pmPalette = [], pmHexes = [], pmInfo = null;

// Стан «Вибору маски» — у папці даних панелі (JSX пише, панель читає)
async function readPmState() {
  var df = await lfs.getDataFolder();
  var entry = await df.getEntry('pm_state.json');
  return JSON.parse(await entry.read());
}

function hideMaskPalette() {
  var box = document.getElementById('pmPalette');
  box.style.display = 'none';
  box.innerHTML = '';
}

function renderMaskPalette() {
  var box = document.getElementById('pmPalette');
  box.innerHTML = '';
  var msg = document.createElement('div');
  msg.className = 'pm-msg';
  msg.textContent = 'Маска ' + (pmInfo.index + 1) + '/' + pmInfo.count + ' → шар «' + pmInfo.targetName + '». ' +
    'Піпеткою по деталі (або по кольору): клік — тільки вона, Shift+клік — додати, Alt+клік — прибрати. Вибрано: ' + pmHexes.length;
  box.appendChild(msg);
  pmPalette.forEach(function (hex) {
    var sw = document.createElement('div');
    sw.className = 'pm-sw' + (pmHexes.indexOf(hex) !== -1 ? ' on' : '');
    sw.style.backgroundColor = '#' + hex;
    sw.title = '#' + hex + (pmHexes.indexOf(hex) !== -1 ? ' — у масці' : '') + '. Клік — тільки ця деталь, Shift — додати, Alt — прибрати';
    sw.addEventListener('click', function (ev) { pmToggleHex(hex, ev.altKey ? 'remove' : (ev.shiftKey ? 'add' : 'replace')); });
    box.appendChild(sw);
  });
  if (!pmPalette.length) {
    var n = document.createElement('div');
    n.className = 'pm-msg';
    n.textContent = '(палітра порожня — клацай піпеткою по моделі)';
    box.appendChild(n);
  }
  var row = document.createElement('div');
  row.className = 'pm-row';
  var done = document.createElement('div');
  done.className = 'btn b-launch';
  done.textContent = 'Готово';
  done.title = 'Завершити вибір: сховати ID-маску, повернутись на коригувальний шар';
  done.addEventListener('click', pmFinish);
  row.appendChild(done);
  box.appendChild(row);
  box.style.display = 'block';
}

// mode: replace (клік) / add (Shift) / remove (Alt); fromSampler — колір з точки Color Sampler
async function pmToggleHex(hex, mode, fromSampler) {
  if (!pmPicking || pmBusy) return;
  pmBusy = true;
  setStatus((hex ? '#' + hex : 'Tochka') + '...', '');
  try {
    await runPartMasks('bind_hex',
      '$.global.__PM_HEX = "' + (hex || '') + '";\n' +
      '$.global.__PM_MODE = "' + (mode || 'replace') + '";\n' +
      '$.global.__PM_FROM_SAMPLER = ' + (fromSampler ? 'true' : 'false') + ';\n');
    var st = await readPmState();
    if (st.hexes) pmHexes = st.hexes;
    if (st.targetName) pmInfo.targetName = st.targetName;
    renderMaskPalette();
    if (st.msg) setStatus(st.msg, 'err');
    else setStatus('Detalej u masci: ' + pmHexes.length, 'ok');
  } catch (e) { setStatus('ERR: ' + (e.message || e), 'err'); }
  pmBusy = false;
}

async function pmFinish() {
  pmPicking = false;
  hideMaskPalette();
  try { await runPartMasks('pick_end', ''); } catch (e) { setStatus('ERR: ' + (e.message || e), 'err'); return; }
  setStatus('Gotovo', 'ok');
  clearStatus();
}

// Піпетка: клік → основний колір (тільки ця деталь); Alt+клік → фоновий колір (прибрати);
// Shift+клік → Photoshop ставить точку Color Sampler (додати)
// Під час вибору користувач клацнув інший шар у Layers → маска переходить на нього (без «Готово»).
// Свої ж перемикання скрипта відсіюються: через 0.35 с дивимось, який шар РЕАЛЬНО активний.
var pmRetargetTimer = null;
function pmScheduleRetarget() {
  if (pmRetargetTimer) clearTimeout(pmRetargetTimer);
  pmRetargetTimer = setTimeout(pmMaybeRetarget, 350);
}
async function pmMaybeRetarget() {
  pmRetargetTimer = null;
  if (!pmPicking || !pmInfo) return;
  if (pmBusy) { pmScheduleRetarget(); return; }
  var id = null;
  try { var al = psApp.activeDocument.activeLayers; if (al && al.length === 1) id = al[0].id; } catch (_) {}
  if (id === null || id == pmInfo.targetId || id == pmInfo.maskId) return;
  pmBusy = true;
  try {
    await runPartMasks('retarget', '');
    var st = await readPmState();
    if (st.active) {
      var moved = st.targetId != pmInfo.targetId;
      pmInfo = st;
      pmPalette = st.palette || pmPalette;
      pmHexes = st.hexes || [];
      renderMaskPalette();
      if (st.msg) setStatus(st.msg, 'err');
      else if (moved) setStatus('Маска → ' + st.targetName, 'ok');
    }
  } catch (e) { setStatus('ERR: ' + (e.message || e), 'err'); }
  pmBusy = false;
}

function pmOnEvent(event, desc) {
  if (!pmPicking) return;
  var t = '';
  try { t = JSON.stringify(desc || {}); } catch (_) {}
  if (event === 'select') {                       // виділення шару (не інструмента)
    if (t.indexOf('"layer"') !== -1 || t.indexOf('layerID') !== -1) pmScheduleRetarget();
    return;
  }
  if (pmBusy) return;
  var hex = '';
  if (event === 'set' && t.indexOf('foregroundColor') !== -1) {
    try { hex = psApp.foregroundColor.rgb.hexValue; } catch (_) {}
    if (hex) pmToggleHex(hex.toUpperCase(), 'replace');
  } else if (event === 'set' && t.indexOf('backgroundColor') !== -1) {
    try { hex = psApp.backgroundColor.rgb.hexValue; } catch (_) {}
    if (hex) pmToggleHex(hex.toUpperCase(), 'remove');
  } else if (event === 'make' && t.indexOf('colorSampler') !== -1) {
    pmToggleHex('', 'add', true).then(pmRefocus, pmRefocus);
  }
}
try { psAction.addNotificationListener(['set', 'make', 'select'], pmOnEvent); } catch (e) { console.log('PM listener:', e); }

// Повернути панель PS Tools на передній план (після Shift+клік Photoshop перемикає на Info)
function pmRefocus() {
  try {
    var pm = require('uxp').pluginManager;
    var list = Array.from ? Array.from(pm.plugins) : pm.plugins;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === 'com.hrebeniuk.pstools') { list[i].showPanel('mainPanel'); break; }
    }
  } catch (e) { console.log('refocus:', e); }
}

async function handlePickMask() {
  if (!psApp || psApp.documents.length === 0) { setStatus('Vidkryj PSD!', 'err'); return; }
  var next = pmPicking;          // повторне натискання під час вибору → наступна маска групи
  pmPicking = false;
  hideMaskPalette();
  setStatus('Maska...', '');
  try {
    await runPartMasks('pick_start', '$.global.__PM_NEXT = ' + (next ? 'true' : 'false') + ';\n');
    var st = await readPmState();
    if (!st.active) { setStatus('—', ''); return; }
    pmInfo = st;
    pmPalette = st.palette || [];
    pmHexes = st.hexes || [];
    try {
      await psCore.executeAsModal(async function () {
        await bp([{ _obj: 'select', _target: [{ _ref: 'eyedropperTool' }] }]);
      }, { commandName: 'Eyedropper' });
    } catch (_) {}
    pmPicking = true;
    renderMaskPalette();
    setStatus('Klacaj pipetkoyu po detalyah', '');
  } catch (e) {
    setStatus('ERR: ' + (e.message || e), 'err');
  }
}

// ── Button wiring ────────────────────────────────────────────
function syncRename() {
  document.getElementById('renameFields').style.display = document.getElementById('chkRename').checked ? 'flex' : 'none';
}
document.getElementById('chkRename').addEventListener('change', syncRename);
document.getElementById('chkRenameText').addEventListener('click', function () {
  var c = document.getElementById('chkRename'); c.checked = !c.checked; syncRename();
});
document.getElementById('btnLoad').addEventListener('click', withButton('btnLoad', handleLoadImages));
document.getElementById('btnReplace').addEventListener('click', withButton('btnReplace', handleReplaceRenders));
document.getElementById('btnMasks').addEventListener('click', withButton('btnMasks', handleReplaceMasks));
document.getElementById('btnPmShow').addEventListener('click', withButton('btnPmShow', handlePickMask));
document.getElementById('btnPmApply').addEventListener('click', withButton('btnPmApply', handlePartMasks('apply')));
document.getElementById('btnBatch').addEventListener('click', withButton('btnBatch', handleBatchExport));

// ═══════════════════════════════════════════════════════════════
//  ОНОВЛЕННЯ — як хаб у Blender: панель сама дивиться на сайт при відкритті Photoshop.
//  Нова версія з'являється на сайті ТІЛЬКИ коли автор запустив ОПУБЛІКУВАТИ_PS.bat.
//  Скрипти (jsx) оновлюються кнопкою без перезапуску; нова панель — через пакет (ВСТАНОВИТИ.bat).
// ═══════════════════════════════════════════════════════════════
var PST = window.__PST || { shellVersion: '0', uiVersion: '0', uiSource: '?', bundledVersion: '0' };
var PANEL_VERSION = PST.uiVersion;  // версія панелі (вмісту) — оновлюється кнопкою разом зі скриптами
var UPD_BASE = 'https://grebenukevgen41-web.github.io/hrebeniuk-tools/ps/';
var updRemote = null, updKind = '';

function verGt(a, b) {
  var x = String(a).split('.'), y = String(b).split('.');
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10);
    if (p !== q) return p > q;
  }
  return false;
}

// FNV-1a 32 по байтах — перевірка, що файл завантажився цілим
function fnv32(bytes) {
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

async function localScriptsVersion() {
  try {
    var df = await lfs.getDataFolder();
    var f = await df.getEntry('scripts_version.txt');
    var t = String(await f.read()).trim();
    if (t) return t;
  } catch (_) {}
  return PST.bundledVersion;
}

function updShow(html, title) {
  var el = document.getElementById('updBox');
  if (!el) return;
  el.innerHTML = html;
  el.title = title || '';
  el.style.display = html ? 'block' : 'none';
}

async function checkUpdates(manual) {
  try {
    var r = await fetch(UPD_BASE + 'version.json?t=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    updRemote = await r.json();
  } catch (e) {
    if (manual) setStatus('Немає зв’язку з сайтом оновлень', 'err');
    return;
  }
  var local = await localScriptsVersion();
  var notes = updRemote.notes ? String(updRemote.notes) : '';
  if (updRemote.shell_version && verGt(updRemote.shell_version, PST.shellVersion)) {   // рамка змінилась — тільки пакетом (рідко)
    updShow('&#8595; Нова версія v' + updRemote.version + ' — завантаж пакет', notes);
    updKind = 'panel';
  } else if (verGt(updRemote.version, local) || verGt(updRemote.version, PANEL_VERSION)) {
    updShow('&#8595; Оновити до v' + updRemote.version, notes);
    updKind = 'scripts';
  } else {
    updShow('', '');
    if (manual) { setStatus('Остання версія (v' + local + ')', 'ok'); clearStatus(); }
  }
  showVersion(local);
}

function showVersion(scripts) {
  var vl = document.getElementById('verLabel');
  if (vl) vl.textContent = 'v' + PANEL_VERSION + (scripts && scripts !== PANEL_VERSION ? ' · скрипти v' + scripts : '');
}

async function installScripts() {
  if (!updRemote) return;
  setStatus('Завантаження v' + updRemote.version + '...', '');
  var df = await lfs.getDataFolder();
  var dir;
  try { dir = await df.getEntry('upd'); } catch (_) { dir = await df.createFolder('upd'); }
  var names = [], uiFiles = [];
  for (var i = 0; i < updRemote.files.length; i++) {
    var fi = updRemote.files[i];
    var r = await fetch(UPD_BASE + fi.path + '?t=' + Date.now());
    if (!r.ok) throw new Error(fi.path + ': HTTP ' + r.status);
    var bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length !== fi.size || fnv32(bytes) !== fi.fnv) throw new Error(fi.path + ': файл пошкоджено, спробуй ще раз');
    var name = fi.path.split('/').pop();
    if (fi.path.indexOf('ui/') === 0) { uiFiles.push({ name: name, bytes: bytes }); continue; }
    var f = await dir.createFile(name, { overwrite: true });
    await f.write(bytes.buffer, { format: uxp.storage.formats.binary });
    names.push(name);
  }
  // копіювання в %APPDATA%\HrebeniukTools\jsx робить JSX (панель туди сама писати не може); стару версію — в _backup
  var src = dir.nativePath.replace(/\\/g, '/');
  var res = (df.nativePath + '/upd_result.txt').replace(/\\/g, '/');
  var jsx =
    'var S = "' + src + '", N = ' + JSON.stringify(names) + ', V = "' + updRemote.version + '";\n' +
    'var R = Folder.userData + "/HrebeniukTools", J = new Folder(R + "/jsx"), ok = 0, err = [];\n' +
    'if (!J.exists) J.create();\n' +
    'var B = new Folder(R + "/_backup/before_" + V); if (!B.exists) { new Folder(R + "/_backup").create(); B.create(); }\n' +
    'for (var i = 0; i < N.length; i++) { var o = new File(J + "/" + N[i]); if (o.exists) o.copy(B + "/" + N[i]);\n' +
    '  if (new File(S + "/" + N[i]).copy(J + "/" + N[i])) ok++; else err.push(N[i]); }\n' +
    'var vf = new File(R + "/version.json"); vf.encoding = "UTF-8"; vf.open("w"); vf.write("{\\"version\\": \\"" + V + "\\"}"); vf.close();\n' +
    'var rf = new File("' + res + '"); rf.open("w"); rf.write(err.length ? "ERR " + err.join(",") : "OK " + ok); rf.close();\n';
  var w = await df.createFile('upd_run.jsx', { overwrite: true });
  await w.write(jsx);
  var token = lfs.createSessionToken(w);
  await psCore.executeAsModal(async function () {
    await bp([{ _obj: 'AdobeScriptAutomation Scripts', javaScript: { _path: token, _kind: 'local' },
                javaScriptMessage: 'pstools_update', _options: { dialogOptions: 'dontDisplay' } }]);
  }, { commandName: 'PS Tools update' });
  var out = String(await (await df.getEntry('upd_result.txt')).read());
  if (out.indexOf('OK') !== 0) throw new Error('не скопійовано: ' + out);
  var vf = await df.createFile('scripts_version.txt', { overwrite: true });
  await vf.write(updRemote.version);
  if (uiFiles.length) {
    // нова панель — у папку даних, файли перезаписуються на місці (непорожню папку UXP не видаляє і не замінює).
    // ui_version.txt — ОСТАННІМ: поки його нема/старий, рамка бере вбудовану панель, тож обірваний запис не зламає її.
    var ud;
    try { ud = await df.getEntry('ui'); } catch (_) { ud = await df.createFolder('ui'); }
    uiFiles.sort(function (a, b) { return (a.name === 'ui_version.txt') - (b.name === 'ui_version.txt'); });
    try { var oldV = await ud.getEntry('ui_version.txt'); await oldV.delete(); } catch (_) {}
    for (var u = 0; u < uiFiles.length; u++) {
      var uf = await ud.createFile(uiFiles[u].name, { overwrite: true });
      await uf.write(uiFiles[u].bytes.buffer, { format: uxp.storage.formats.binary });
    }
  }
  updShow('', '');
  showVersion(updRemote.version);
  setStatus(uiFiles.length ? 'Оновлено до v' + updRemote.version + ' ✓ Закрий і відкрий панель (або перезапусти Photoshop)'
                           : 'Оновлено до v' + updRemote.version + ' ✓', 'ok');
}

async function handleUpdateClick() {
  var box = document.getElementById('updBox');
  if (updKind === 'panel') {
    try { await uxp.shell.openExternal(UPD_BASE + 'PS_Tools.zip'); } catch (e) { setStatus('ERR: ' + (e.message || e), 'err'); }
    setStatus('Розпакуй архів, закрий Photoshop і запусти ВСТАНОВИТИ.bat', '');
    return;
  }
  try { await installScripts(); } catch (e) { setStatus('ERR: ' + (e.message || e), 'err'); }
}

document.getElementById('updBox').addEventListener('click', withButton('updBox', handleUpdateClick));
document.getElementById('verLabel').addEventListener('click', function () { checkUpdates(true); });
showVersion('');
setTimeout(function () { checkUpdates(false); }, 3000);

console.log('[PSTools] v' + PANEL_VERSION + ' loaded'); if (psApp) { setStatus('v' + PANEL_VERSION + ' Ready', ''); } else { setStatus('PS API not loaded', 'err'); }
