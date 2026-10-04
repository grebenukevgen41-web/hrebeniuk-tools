/**
 * Part Masks — Hrebeniuk_Tools
 *
 * Коригувальний шар прив'язується до ДЕТАЛІ моделі через колір ID-маски,
 * потім переноситься на інші групи — маска перебудовується з ID-маски кожної групи.
 *
 * Дії ($.global.__PM_ACTION):
 *   "toggle" — показати/сховати ID-маску групи активного шару
 *   "bind"   — активний коригувальний шар → маска з кольору Foreground (піпетка)
 *   "apply"  — прив'язані шари активної групи → на вибрані групи
 * Параметри: __PM_FUZZ (допуск 0..200)
 *
 * Універсально: тип ID-маски не вибирається. Інструмент бере всі ID-маски групи
 * (WireColor / ID / _mask_obj / _mask_mat / _mask_face …) і використовує ту, де є колір.
 * Тег у назві шару: "Curves 1 ‹E34A2F›"  (колір деталі)
 * Умова переносу:
 *   колір є в ID-масці цільової групи → TRUE  → шар + маска з кольору
 *   кольору нема                      → FALSE → шар з ПОРОЖНЬОЮ маскою і "⚠" у назві
 *                                               (або пропуск — вибір у діалозі)
 *   ID-маски в групи не знайдено      → пропуск, у звіті
 */

#target photoshop

var PM_FUZZ = (typeof $.global.__PM_FUZZ !== 'undefined' && $.global.__PM_FUZZ !== null) ? Number($.global.__PM_FUZZ) : 12;
var PM_ACTION = (typeof $.global.__PM_ACTION !== 'undefined' && $.global.__PM_ACTION) ? $.global.__PM_ACTION : 'apply';

var TAG_RE = /\s*‹(?:(?:obj|mat|face) )?([0-9A-Fa-f]{6}(?:\+[0-9A-Fa-f]{6})*)›\s*$/;   // ‹HEX› або ‹HEX+HEX› (кілька деталей); старий ‹obj HEX› теж
function tagHexes(name) { var m = TAG_RE.exec(name); return m ? m[1].toUpperCase().split('+') : []; }
var WARN = '⚠ ';
var PM_FEATHER = 0.7;   // пом'якшення краю маски, px
// Новий альфа-канал, але активними лишаються RGB-канали (інакше Color Range шукає в сірому каналі)
function newChan(d) {
    var ch = d.channels.add();
    try { d.activeChannels = d.componentChannels; } catch (e) {}
    return ch;
}

var PM_CACHE = null;    // { key: channel } — кеш виділень, живе лише під час переносу
var PM_BOX = 3;         // ±Lab навколо кольору деталі, що вважається 100% деталлю
var PM_CLOSE = 2;       // «зашити» шви між сусідніми деталями: розширити і стиснути на N px

// Спільне правило «це маска?» (Corona / V-Ray / 3ds Max / Blender) — mask_names.jsx поруч
var __MN_FILE = new File(new File($.fileName).parent + '/mask_names.jsx');
if (!__MN_FILE.exists) __MN_FILE = new File(Folder.userData + '/HrebeniukTools/jsx/mask_names.jsx');
$.evalFile(__MN_FILE);
var PM_TEX_FUZZ = 40;   // мінімальний допуск для текстурних масок (SourceColor / Albedo)

function cTID(s) { return charIDToTypeID(s); }
function sTID(s) { return stringIDToTypeID(s); }

// ── Шари ─────────────────────────────────────────────────────────────────────

// ID-маска — лише піксельний шар; корекція з «mask/id» у назві — не маска
function isMaskLayer(l) { return l.typename == 'ArtLayer' && isMaskName(l.name) && !isAdjustment(l); }
function isTexturedMask(l) { var i = maskInfo(l.name); return !!(i && i.textured); }

// Група рендера шару. Папка лише з корекціями всередині групи — не група рендера → беремо батьківську.
function containingGroup(layer) {
    var g = layer.typename == 'LayerSet' ? layer : layer.parent;
    if (!g || g.typename != 'LayerSet') return null;
    var first = g;
    while (!isContentGroup(g) && g.parent && g.parent.typename == 'LayerSet') g = g.parent;
    return isContentGroup(g) ? g : first;
}

// Група рендера: є піксельний шар (не ID-маска) або ID-маска разом з корекціями
function isContentGroup(g) {
    var mask = false, corr = false;
    for (var j = 0; j < g.layers.length; j++) {
        var l = g.layers[j];
        if (l.typename != 'ArtLayer') continue;
        if (isAdjustment(l)) corr = true;
        else if (isMaskName(l.name)) mask = true;
        else return true;
    }
    return mask && corr;
}

// Шари групи разом із вкладеними папками корекцій (але не вкладеними групами рендерів), знизу вгору.
// Папка корекцій з маскою (або з міткою) — одна одиниця переносу: копіюється цілком, маска — на папці.
function groupArtLayers(g, out) {
    for (var i = g.layers.length - 1; i >= 0; i--) {
        var l = g.layers[i];
        if (l.typename == 'LayerSet') {
            if (isContentGroup(l)) continue;
            if (TAG_RE.test(l.name) || layerHasUserMask(l)) out.push(l);
            else groupArtLayers(l, out);
        }
        else out.push(l);
    }
    return out;
}

// «Око» шару через ActionManager: DOM .visible бреше (false) для шарів усередині прихованої групи
function amVisible(l) {
    var r = new ActionReference(); r.putIdentifier(cTID('Lyr '), l.id);
    return executeActionGet(r).getBoolean(cTID('Vsbl'));
}
function amSetVisible(l, v) {
    var d = new ActionDescriptor(), list = new ActionList(), r = new ActionReference();
    r.putIdentifier(cTID('Lyr '), l.id); list.putReference(r); d.putList(cTID('null'), list);
    executeAction(cTID(v ? 'Shw ' : 'Hd  '), d, DialogModes.NO);
}

// Маска шару/папки — без виділення (виділення може ввімкнути «око»)
function layerHasUserMask(l) {
    var r = new ActionReference(); r.putIdentifier(cTID('Lyr '), l.id);
    try { return executeActionGet(r).getBoolean(sTID('hasUserMask')); } catch (e) { return false; }
}

// Корекція для переносу: коригувальний шар / заливка, або папка лише з корекціями
function isCorrection(l) { return l.typename == 'LayerSet' ? !isContentGroup(l) : isAdjustment(l); }

function allArtLayers(layers, out) {
    for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.typename == 'LayerSet') allArtLayers(l.layers, out);
        else out.push(l);
    }
    return out;
}

// Контентні групи = групи без ID-масок серед прямих дітей (або з ними всередині, але з рендером)
function contentGroups(doc) {
    var res = [];
    function walk(sets) {
        for (var i = 0; i < sets.length; i++) {
            var g = sets[i];
            if (isContentGroup(g)) res.push(g);
            walk(g.layerSets);
        }
    }
    walk(doc.layerSets);
    return res;
}

var PM_STOP = { cmasking: 1, cshading: 1, id: 1, wirecolor: 1, wire: 1, color: 1, mask: 1, masks: 1, masking: 1, matte: 1,
                object: 1, material: 1, mtl: 1, obj: 1, mat: 1, face: 1, sourcecolor: 1, albedo: 1, copy: 1, layer: 1 };
function tokens(name) {
    var parts = name.toLowerCase().replace(/vray\w+|multimatte\w*/g, ' ').split(/[\s_\-\.]+/);
    var out = {};
    for (var i = 0; i < parts.length; i++) {
        var t = parts[i].replace(/\d+$/, '');
        if (t.length > 1 && !PM_STOP[t]) out[t] = true;
    }
    return out;
}

// Усі маски групи. Плоскі — перед текстурними.
//  1) маски всередині групи; якщо серед них є плоска — тільки вони
//  2) інакше + маски документа: з тією ж назвою рендера, або тієї ж моделі —
//     збігаються всі слова назви групи, крім одного (колір варіанта), і не менше 2
function maskCandidates(doc, group) {
    var ck = 'mc' + group.id;                     // під час переносу маски не змінюються → кеш
    if (PM_DET && PM_DET[ck]) return PM_DET[ck];
    var r = maskCandidatesRaw(doc, group);
    if (PM_DET) PM_DET[ck] = r;
    return r;
}
function maskCandidatesRaw(doc, group) {
    var own = [], i, gk = groupKey(group.name);
    for (i = 0; i < group.layers.length; i++) if (isMaskLayer(group.layers[i])) own.push(group.layers[i]);
    var ownFlat = false;
    for (i = 0; i < own.length; i++) if (!isTexturedMask(own[i])) ownFlat = true;
    var res = own;
    if (!ownFlat) {
        var all = allArtLayers(doc.layers, []), exact = [], scored = [], gt = tokens(group.name), gn = 0;
        for (var t0 in gt) gn++;
        var need = Math.max(2, gn - 1);
        for (i = 0; i < all.length; i++) {
            var c = all[i];
            if (!isMaskLayer(c) || c.parent == group) continue;
            var bs = maskInfo(c.name).bases, hit = false;
            for (var k = 0; k < bs.length; k++) if (bs[k] == gk) hit = true;
            if (hit) { exact.push(c); continue; }
            var ct = tokens(c.name), score = 0;
            for (var t in gt) if (ct[t]) score++;
            if (score >= need) scored.push([c, score]);
        }
        scored.sort(function (x, y) { return y[1] - x[1]; });
        res = own.concat(exact);
        // точний збіг назви рендера є → інші ракурси/моделі не чіпаємо
        if (!exact.length) for (i = 0; i < scored.length; i++) res.push(scored[i][0]);
    }
    var flat = [], tex = [];
    for (i = 0; i < res.length; i++) (isTexturedMask(res[i]) ? tex : flat).push(res[i]);
    return flat.concat(tex);
}


// Виділення = об'єднання деталей (кольори можуть бути в різних масках групи).
// Повертає кількість знайдених кольорів; виділення лишається активним.
// Закрити щілини між сусідніми деталями (змішані кольори на шві не потрапляють у жоден колір):
// розширити на n px і стиснути назад — зовнішній край на місці, шви до 2n px зникають
function closeGaps(n) {
    if (!n) return;
    try {
        var e = new ActionDescriptor();
        e.putUnitDouble(cTID('By  '), cTID('#Pxl'), n);
        e.putBoolean(sTID('selectionModifyEffectAtCanvasBounds'), false);
        executeAction(cTID('Expn'), e, DialogModes.NO);
        var c = new ActionDescriptor();
        c.putUnitDouble(cTID('By  '), cTID('#Pxl'), n);
        c.putBoolean(sTID('selectionModifyEffectAtCanvasBounds'), false);
        executeAction(cTID('Cntc'), c, DialogModes.NO);
    } catch (err) {}
}

function cacheChannels() { return PM_CACHE; }
function clearCache(doc) {
    if (!PM_CACHE) return;
    for (var k in PM_CACHE) { try { PM_CACHE[k].remove(); } catch (e) {} }
    PM_CACHE = null;
}
function cacheGet(doc, key) {
    if (!PM_CACHE || !PM_CACHE[key]) return false;
    doc.selection.load(PM_CACHE[key], SelectionType.REPLACE);
    return true;
}
function cachePut(doc, key) {
    if (!PM_CACHE) return;
    var ch = newChan(doc); ch.name = '__pm_k' + (new Date().getTime() % 100000) + Math.floor(Math.random() * 1000);
    doc.selection.store(ch, SelectionType.REPLACE);
    PM_CACHE[key] = ch;
}

function selectHexesUnion(doc, group, hexes, preferName) {
    if (hexes.length == 1) return selectHexesUnionRaw(doc, group, hexes, preferName);   // одна деталь — кеш не потрібен
    var key = 'u|' + group.id + '|' + hexes.join('+');
    if (PM_CACHE && PM_CACHE[key + '|n']) { if (PM_CACHE[key + '|n'].n > 0) cacheGet(doc, key); return PM_CACHE[key + '|n'].n; }
    var n = selectHexesUnionRaw(doc, group, hexes, preferName);
    if (PM_CACHE) { if (n > 0) cachePut(doc, key); PM_CACHE[key + '|n'] = { n: n, remove: function () {} }; }
    return n;
}

function selectHexesUnionRaw(doc, group, hexes, preferName) {
    if (hexes.length == 1) return findMaskWithColor(doc, group, hexes[0], PM_FUZZ, preferName).mask ? 1 : 0;
    var ch = null, found = 0;
    for (var i = 0; i < hexes.length; i++) {
        var r = findMaskWithColor(doc, group, hexes[i], PM_FUZZ, preferName);
        if (!r.mask) continue;
        found++;
        if (!ch) { ch = newChan(doc); ch.name = '__pm_union'; doc.selection.store(ch, SelectionType.REPLACE); }
        else doc.selection.store(ch, SelectionType.EXTEND);
    }
    if (ch) { doc.selection.load(ch, SelectionType.REPLACE); ch.remove(); }
    if (found > 1) closeGaps(PM_CLOSE);
    return found;
}

function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b), n = 0;
    for (var t in ta) if (tb[t]) n++;
    return n;
}

// Перша маска групи, де є колір (виділення лишається активним).
// Порядок: видима маска → схожа на preferName → решта.
function findMaskWithColor(doc, group, hex, fuzz, preferName) {
    var cands = maskCandidates(doc, group);
    var order = [];
    for (var j = 0; j < cands.length; j++) order.push(j);
    order.sort(function (x, y) {
        var a = cands[x], b = cands[y];
        var va = a.visible ? 1 : 0, vb = b.visible ? 1 : 0;
        if (va != vb) return vb - va;
        var ta = isTexturedMask(a) ? 1 : 0, tb = isTexturedMask(b) ? 1 : 0;
        if (ta != tb) return ta - tb;
        var d = preferName ? similarity(b.name, preferName) - similarity(a.name, preferName) : 0;
        return d != 0 ? d : x - y;
    });
    for (var i = 0; i < order.length; i++) {
        var c = cands[order[i]];
        var fz = isTexturedMask(c) ? Math.max(fuzz, PM_TEX_FUZZ) : fuzz;
        if (selectColor(doc, c, hex, fz)) return { mask: c, count: cands.length, fuzz: fz };
    }
    return { mask: null, count: cands.length };
}

// Вибрати шар без зміни видимості (DOM activeLayer вмикає видимість)
function selectLayer(layer) {
    var ref = new ActionReference();
    ref.putIdentifier(cTID('Lyr '), layer.id);
    var d = new ActionDescriptor();
    d.putReference(cTID('null'), ref);
    d.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), d, DialogModes.NO);
}

function activeHasUserMask() {
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    return executeActionGet(ref).getBoolean(sTID('hasUserMask'));
}

// Коригувальний шар або шар-заливка (Solid Color / Gradient / Pattern) — без пікселів рендера
function isAdjustment(layer) {
    if (layer.typename != 'ArtLayer') return false;
    var k;
    try { k = layer.kind; } catch (e) { return true; }   // нові типи корекцій DOM може не знати
    return k != LayerKind.NORMAL && k != LayerKind.TEXT && k != LayerKind.SMARTOBJECT &&
           k != LayerKind.VIDEO && k != LayerKind.LAYER3D;
}

// ── Виділення за кольором ────────────────────────────────────────────────────

// Показує шар і всіх батьків на час дії; повертає функцію відновлення
function forceVisible(layer) {
    var saved = [];
    var l = layer;
    while (l && l.typename != 'Document') {
        var v = amVisible(l);
        saved.push([l, v]);
        if (!v) amSetVisible(l, true);
        l = l.parent;
    }
    return function () {
        for (var i = 0; i < saved.length; i++) if (amVisible(saved[i][0]) != saved[i][1]) amSetVisible(saved[i][0], saved[i][1]);
    };
}

// Лишає видимим ТІЛЬКИ цей шар (Color Range бере видиме зображення, а не активний шар).
// Ховає сусідів на кожному рівні вгору по дереву; повертає функцію відновлення.
function soloVisible(layer) {
    var saved = [];
    function set(l, v) { var c = amVisible(l); if (c != v) { saved.push([l, c]); amSetVisible(l, v); } }
    var l = layer;
    while (l && l.typename != 'Document') {
        set(l, true);
        var sibs = l.parent.layers;
        for (var i = 0; i < sibs.length; i++) {
            if (sibs[i] == l) break;          // усе, що нижче, перекрите маскою
            set(sibs[i], false);
        }
        l = l.parent;
    }
    return function () { for (var k = saved.length - 1; k >= 0; k--) amSetVisible(saved[k][0], saved[k][1]); };
}

// Color Range по шару-масці. true — якщо щось виділилось
// Під час переносу (PM_CACHE) колір у конкретній масці шукається один раз:
// групи одного ракурсу (різні кольори моделі) ділять ті самі маски.
// Стара назва службових каналів (кеш, від якого відмовились) — прибираємо, якщо лишились у файлі
var PMC = '__pmc_';
function clearPickCache(doc) {
    for (var i = doc.channels.length - 1; i >= 0; i--) {
        var ch = doc.channels[i];
        try { if (ch.kind != ChannelType.COMPONENT && ch.name.indexOf(PMC) == 0) ch.remove(); } catch (e) {}
    }
}

function selectColor(doc, maskLayer, hex, fuzz) {
    if (!PM_CACHE || PM_HELP) return selectColorRaw(doc, maskLayer, hex, fuzz);   // допоміжні документи самі тримають готові виділення
    var key = 'c|' + maskLayer.id + '|' + hex + '|' + fuzz;
    var hit = PM_CACHE[key + '|n'];
    if (hit) { if (hit.n) cacheGet(doc, key); else { try { doc.selection.deselect(); } catch (e) {} } return !!hit.n; }
    var ok = selectColorRaw(doc, maskLayer, hex, fuzz);
    if (ok) cachePut(doc, key);
    PM_CACHE[key + '|n'] = { n: ok ? 1 : 0, remove: function () {} };
    return ok;
}

var PM_HELP = null;   // { maskId: document } — лише під час переносу

function helperDoc(doc, mask) {
    if (PM_HELP[mask.id]) return PM_HELP[mask.id];
    var h = app.documents.add(doc.width, doc.height, doc.resolution, 'pm_h_' + mask.id, NewDocumentMode.RGB,
                              DocumentFill.WHITE, 1, BitsPerChannelType.EIGHT);
    app.activeDocument = doc;
    mask.duplicate(h, ElementPlacement.PLACEATBEGINNING);
    app.activeDocument = h;
    if (!h.layers[0].visible) h.layers[0].visible = true;
    h.flatten();
    app.activeDocument = doc;
    PM_HELP[mask.id] = h;
    return h;
}

function closeHelpers(doc) {
    if (!PM_HELP) return;
    for (var k in PM_HELP) { try { PM_HELP[k].close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} }
    PM_HELP = null;
    try { app.activeDocument = doc; } catch (e2) {}
}

// Color Range в активному документі (весь документ = одна маска)
function colorRangeActive(hex, fuzz) {
    var c = new SolidColor();
    c.rgb.hexValue = hex;
    function labBox(sign) {
        var o = new ActionDescriptor();
        o.putDouble(cTID('Lmnc'), Math.max(0, Math.min(100, c.lab.l + sign * PM_BOX)));
        o.putDouble(cTID('A   '), Math.max(-128, Math.min(127, c.lab.a + sign * PM_BOX)));
        o.putDouble(cTID('B   '), Math.max(-128, Math.min(127, c.lab.b + sign * PM_BOX)));
        return o;
    }
    var d = new ActionDescriptor();
    d.putInteger(cTID('Fzns'), fuzz);
    d.putObject(cTID('Mnm '), cTID('LbCl'), labBox(-1));
    d.putObject(cTID('Mxm '), cTID('LbCl'), labBox(1));
    d.putInteger(sTID('colorModel'), 0);
    try { executeAction(cTID('ClrR'), d, DialogModes.NO); } catch (e) { return false; }
    try { app.activeDocument.selection.bounds; return true; } catch (e2) { return false; }
}

// Через допоміжний документ: пошук кольору там, виділення → у робочий документ
function selectColorHelper(doc, mask, hex, fuzz) {
    var h = helperDoc(doc, mask);
    app.activeDocument = h;
    try { h.selection.deselect(); } catch (e0) {}
    var ok = colorRangeActive(hex, fuzz), chName = 'c' + hex + '_' + fuzz;
    if (ok) {
        var ch = null;
        try { ch = h.channels.getByName(chName); } catch (e1) {}
        if (!ch) { ch = newChan(h); ch.name = chName; }
        h.selection.store(ch, SelectionType.REPLACE);
    }
    app.activeDocument = doc;
    if (!ok) { try { doc.selection.deselect(); } catch (e2) {} return false; }
    var r = new ActionReference(); r.putName(cTID('Chnl'), chName); r.putName(cTID('Dcmn'), h.name);
    var d = new ActionDescriptor(); d.putReference(cTID('null'), selRef()); d.putReference(cTID('T   '), r);
    executeAction(cTID('setd'), d, DialogModes.NO);
    return true;
}

function selectColorRaw(doc, maskLayer, hex, fuzz) {
    if (PM_HELP) return selectColorHelper(doc, maskLayer, hex, fuzz);
    var restore = soloVisible(maskLayer);
    try {
        selectLayer(maskLayer);
        doc.selection.deselect();
        var c = new SolidColor();
        c.rgb.hexValue = hex;
        // «коробка» ±PM_BOX навколо кольору: усе всередині — 100% біле, допуск діє лише за її межами
        function labBox(sign) {
            var o = new ActionDescriptor();
            o.putDouble(cTID('Lmnc'), Math.max(0, Math.min(100, c.lab.l + sign * PM_BOX)));
            o.putDouble(cTID('A   '), Math.max(-128, Math.min(127, c.lab.a + sign * PM_BOX)));
            o.putDouble(cTID('B   '), Math.max(-128, Math.min(127, c.lab.b + sign * PM_BOX)));
            return o;
        }
        var d = new ActionDescriptor();
        d.putInteger(cTID('Fzns'), fuzz);
        d.putObject(cTID('Mnm '), cTID('LbCl'), labBox(-1));
        d.putObject(cTID('Mxm '), cTID('LbCl'), labBox(1));
        d.putInteger(sTID('colorModel'), 0);
        try { executeAction(cTID('ClrR'), d, DialogModes.NO); } catch (e) { return false; }
        try { doc.selection.bounds; return true; } catch (e2) { return false; }
    } finally {
        restore();
    }
}

// Поставити маску шару з поточного виділення (hasSel=false → повністю чорна)
function setLayerMask(doc, layer, hasSel, noFeather) {
    selectLayer(layer);
    if (activeHasUserMask()) {
        var r = new ActionReference();
        r.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
        var dd = new ActionDescriptor();
        dd.putReference(cTID('null'), r);
        executeAction(cTID('Dlt '), dd, DialogModes.NO);
    }
    if (!hasSel) { try { doc.selection.deselect(); } catch (e) {} }
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    var d = new ActionDescriptor();
    d.putClass(cTID('Nw  '), cTID('Chnl'));
    d.putReference(cTID('At  '), ref);
    d.putEnumerated(cTID('Usng'), cTID('UsrM'), hasSel ? cTID('RvlS') : cTID('HdAl'));
    executeAction(cTID('Mk  '), d, DialogModes.NO);
    try { doc.selection.deselect(); } catch (e2) {}
    if (hasSel && !noFeather) setMaskFeather(PM_FEATHER);
}

// Feather маски активного шару — як у панелі Properties (можна змінити вручну)
function setMaskFeather(px) {
    try {
        var r = new ActionReference(); r.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
        var d = new ActionDescriptor(); d.putReference(cTID('null'), r);
        var l = new ActionDescriptor(); l.putUnitDouble(sTID('userMaskFeather'), cTID('#Pxl'), px);
        d.putObject(cTID('T   '), cTID('Lyr '), l);
        executeAction(cTID('setd'), d, DialogModes.NO);
    } catch (e) {}
}
function getMaskFeather() {
    try {
        var r = new ActionReference(); r.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
        return executeActionGet(r).getUnitDoubleValue(sTID('userMaskFeather'));
    } catch (e) { return -1; }
}

function baseName(name) { return name.replace(TAG_RE, '').replace(/^⚠\s*/, ''); }

// ── Дії ──────────────────────────────────────────────────────────────────────

// Кожне натискання показує наступну ID-маску групи; після останньої — ховає всі
function actToggle(doc) {
    var g = containingGroup(doc.activeLayer);
    if (!g) { alert('Виділи шар у групі рендера.'); return; }
    var c = maskCandidates(doc, g);
    if (!c.length) { alert('Для групи "' + g.name + '" не знайдено ID-маску.'); return; }
    var cur = -1;
    for (var i = 0; i < c.length; i++) if (c[i].visible) { cur = i; break; }
    for (var j = 0; j < c.length; j++) if (c[j].visible) c[j].visible = false;
    if (cur + 1 < c.length) forceVisible(c[cur + 1]);
}

// Колір шару-маски в точці (x,y): 1 піксель → тимчасовий документ → семплер
function maskColorAt(doc, mask, x, y) {
    var restore = forceVisible(mask), hex = null;
    try {
        selectLayer(mask);
        x = Math.floor(x); y = Math.floor(y);
        doc.selection.select([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]);
        doc.selection.copy();
    } catch (e) { restore(); try { doc.selection.deselect(); } catch (e1) {} return null; }
    restore();
    try { doc.selection.deselect(); } catch (e2) {}
    var tmp = app.documents.add(1, 1, 72, 'pm_px', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
    try {
        tmp.paste();
        var sm = tmp.colorSamplers.add([0.5, 0.5]);
        hex = sm.color.rgb.hexValue;
    } catch (e3) { hex = null; }
    tmp.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = doc;
    return hex;
}

// Колір деталі для «Прив'язати» (до suspendHistory — бо відкриває тимчасовий документ):
//   є Color Sampler (Shift+клік піпеткою) → колір ID-маски під ОСТАННЬОЮ точкою, точку видаляємо
//   нема → основний колір (піпетка по показаній ID-масці)
function resolveBindColor(doc) {
    var layer = doc.activeLayer;
    if (doc.colorSamplers.length == 0 || layer.parent.typename != 'LayerSet') {
        return { hex: app.foregroundColor.rgb.hexValue, how: 'fg' };
    }
    var smp = doc.colorSamplers[doc.colorSamplers.length - 1];
    var px = smp.position[0].as('px'), py = smp.position[1].as('px');
    var c = maskCandidates(doc, layer.parent);
    c.sort(function (a, b) { return (b.visible ? 1 : 0) - (a.visible ? 1 : 0); });
    var hex = c.length ? maskColorAt(doc, c[0], px, py) : null;
    selectLayer(layer);
    if (hex) smp.remove();
    return { hex: hex || app.foregroundColor.rgb.hexValue, how: hex ? 'sampler' : 'fg' };
}

var PM_BIND = null;

function actBind(doc) {
    var layer = doc.activeLayer;
    if (!isAdjustment(layer)) { alert('Виділи коригувальний шар або заливку (Curves, Hue/Sat, Solid Color...).'); return; }
    var g = layer.parent;
    if (g.typename != 'LayerSet') { alert('Коригувальний шар має бути всередині групи рендера.'); return; }
    var hex = PM_BIND ? PM_BIND.hex : app.foregroundColor.rgb.hexValue;
    var r = findMaskWithColor(doc, g, hex, PM_FUZZ, null);
    if (!r.count) { alert('Для групи "' + g.name + '" не знайдено ID-маску.'); return; }
    if (!r.mask) {
        alert('Колір #' + hex + ' не знайдено в жодній ID-масці групи.\n\n' +
              'Натисни «Вибір маски» і клацни піпеткою по деталі (або по кольору в палітрі панелі).\n' +
              'Або постав точку Color Sampler (Shift+клік піпеткою) на деталі рендера → «Прив\'язати маску».');
        selectLayer(layer);
        return;
    }
    setLayerMask(doc, layer, true);
    layer.name = baseName(layer.name) + ' ‹' + hex.toUpperCase() + '›';
    var c = maskCandidates(doc, g);
    for (var i = 0; i < c.length; i++) if (c[i].visible) c[i].visible = false;
    selectLayer(layer);
}


// ── Вибір маски (панель): показати маску, фокус на ній, стан → файл для панелі ──
function findById(layers, id) {
    for (var i = 0; i < layers.length; i++) {
        if (layers[i].id == id) return layers[i];
        if (layers[i].typename == 'LayerSet') { var f = findById(layers[i].layers, id); if (f) return f; }
    }
    return null;
}

function selectById(doc, id) {
    var ref = new ActionReference();
    ref.putIdentifier(cTID('Lyr '), id);
    var d = new ActionDescriptor();
    d.putReference(cTID('null'), ref);
    d.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), d, DialogModes.NO);
    return doc.activeLayer;
}

function jsonStr(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function statePath() {
    return $.global.__PM_STATE_PATH ? $.global.__PM_STATE_PATH : Folder.userData.fsName + '/HrebeniukTools/pm_state.json';
}

// Прочитати стан вибору з файлу; null — вибір не активний
function readState() {
    try {
        var f = new File(statePath());
        if (!f.exists) return null;
        f.encoding = 'UTF-8'; f.open('r'); var t = f.read(); f.close();
        var o = eval('(' + t + ')');
        return (o && o.active) ? o : null;
    } catch (e) { return null; }
}

function arr(a) {
    var p = [];
    for (var i = 0; i < a.length; i++) p.push('"' + a[i] + '"');
    return '[' + p.join(',') + ']';
}

function writeState(obj) {
    var parts = [];
    for (var k in obj) {
        var v = obj[k];
        parts.push(jsonStr(k) + ':' + (v instanceof Array ? arr(v) : typeof v == 'string' ? (v.charAt(0) == '[' ? v : jsonStr(v)) : String(v)));
    }
    var f = new File(statePath());
    f.encoding = 'UTF-8'; f.open('w'); f.write('{' + parts.join(',') + '}'); f.close();
}

// Новий Curves над верхнім шаром рендера групи
function newCurvesIn(doc, group) {
    var anchor = null;
    for (var i = 0; i < group.layers.length; i++) if (!isMaskLayer(group.layers[i])) { anchor = group.layers[i]; break; }
    if (anchor) selectLayer(anchor);
    var d = new ActionDescriptor(), r = new ActionReference();
    r.putClass(cTID('AdjL')); d.putReference(cTID('null'), r);
    var u = new ActionDescriptor(); u.putClass(cTID('Type'), cTID('Crvs'));
    d.putObject(cTID('Usng'), cTID('AdjL'), u);
    executeAction(cTID('Mk  '), d, DialogModes.NO);
    return doc.activeLayer;
}


// Кольори маски для палітри панелі (частіші за 0.3% площі), найбільші — першими
function maskPalette(doc, mask) {
    var res = [];
    var W = 160, H = Math.max(1, Math.round(W * doc.height.as('px') / doc.width.as('px')));
    var tmp = app.documents.add(doc.width, doc.height, 72, 'pm_pal', NewDocumentMode.RGB, DocumentFill.WHITE, 1, BitsPerChannelType.EIGHT);
    try {
        app.activeDocument = doc;
        mask.duplicate(tmp, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = tmp;
        var top = tmp.layers[0]; if (!top.visible) top.visible = true;
        tmp.flatten();
        tmp.resizeImage(UnitValue(W, 'px'), UnitValue(H, 'px'), 72, ResampleMethod.NEARESTNEIGHBOR);
        var f = new File(Folder.temp + '/pm_pal.raw');
        tmp.saveAs(f, new RawSaveOptions(), true);
        f.encoding = 'BINARY'; f.open('r'); var data = f.read(); f.close(); f.remove();
        var counts = {}, keys = [], total = 0;
        for (var i = 0; i + 2 < data.length; i += 3) {
            var k = data.charCodeAt(i) * 65536 + data.charCodeAt(i + 1) * 256 + data.charCodeAt(i + 2);
            if (!counts[k]) { counts[k] = 0; keys.push(k); }
            counts[k]++; total++;
        }
        keys.sort(function (a, b) { return counts[b] - counts[a]; });
        var picked = [];
        for (var j = 0; j < keys.length && picked.length < 24; j++) {
            if (counts[keys[j]] / total < 0.003) break;
            var r = keys[j] >> 16, g = (keys[j] >> 8) & 255, b = keys[j] & 255, near = false;
            for (var q = 0; q < picked.length; q++)
                if (Math.abs(picked[q][0] - r) + Math.abs(picked[q][1] - g) + Math.abs(picked[q][2] - b) < 18) near = true;
            if (near) continue;
            picked.push([r, g, b]);
            var c = new SolidColor(); c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b;
            res.push(c.rgb.hexValue.toUpperCase());
        }
    } catch (e) {}
    tmp.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = doc;
    return res;
}

function hasMaskOf(layer) { selectLayer(layer); return activeHasUserMask(); }

// Користувач сам виділив інший шар під час вибору (не ціль і не показану ID-маску)
function userSwitched(doc, st) {
    var a = doc.activeLayer;
    return a && a.id != st.targetId && a.id != st.maskId && !isMaskLayer(a);
}

function actPickStart(doc) {
    var st = readState(), group, target, idx, hexes = [];
    if (!($.global.__PM_NEXT && st && st.docName == doc.name)) clearPickCache(doc);   // нова сесія — старий кеш геть
    if ($.global.__PM_NEXT && st && st.docName == doc.name && userSwitched(doc, st)) {
        // «Вибір маски» на іншому шарі — почати на ньому, без «Готово»
        actRetarget(doc);
        return;
    }
    if ($.global.__PM_NEXT && st && st.docName == doc.name) {
        group = selectById(doc, st.groupId); target = selectById(doc, st.targetId);
        idx = st.index + 1; hexes = st.hexes || [];
    } else {
        var layer = doc.activeLayer;
        group = containingGroup(layer);
        if (!group) { writeState({ active: false }); alert('Виділи шар у групі рендера (корекцію, шар або саму групу) — на нього ляже маска.'); return; }
        if (isMaskLayer(layer)) { writeState({ active: false }); alert('Виділи шар, на який має лягти маска (не саму ID-маску).'); return; }
        target = layer;
        idx = 0; hexes = tagHexes(target.name);
    }
    var c = maskCandidates(doc, group);
    if (!c.length) { writeState({ active: false }); selectLayer(target); alert('Для групи "' + group.name + '" не знайдено ID-маску.'); return; }
    for (var j = 0; j < c.length; j++) if (c[j].visible) c[j].visible = false;
    if (idx >= c.length) idx = 0;   // по колу
    var pal = maskPalette(doc, c[idx]);
    // групи, які доведеться увімкнути, щоб показати маску, — запам'ятати й сховати після «Готово»
    var shownIds = (st && $.global.__PM_NEXT && st.shown) ? st.shown : [];
    for (var pa = c[idx].parent; pa && pa.typename == 'LayerSet'; pa = pa.parent)
        if (!pa.visible) shownIds.push(String(pa.id));
    forceVisible(c[idx]);
    selectLayer(c[idx]);
    writeState({ active: true, docName: doc.name, groupId: group.id, targetId: target.id, index: idx,
                 maskId: c[idx].id, maskName: c[idx].name, targetName: baseName(target.name),
                 count: c.length, palette: arr(pal), hexes: arr(hexes), shown: arr(shownIds) });
}

// Клік по деталі: немає в масці → додати, є → прибрати. Маска = об'єднання вибраних деталей.

function featherSel() {
    try {
        var fd = new ActionDescriptor();
        fd.putUnitDouble(cTID('Rds '), cTID('#Pxl'), PM_FEATHER);
        fd.putBoolean(sTID('selectionModifyEffectAtCanvasBounds'), false);
        executeAction(cTID('Fthr'), fd, DialogModes.NO);
    } catch (e) {}
}
function maskChanRef() { var r = new ActionReference(); r.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk ')); return r; }
function selRef() { var r = new ActionReference(); r.putProperty(cTID('Chnl'), cTID('fsel')); return r; }
// виділення += маска активного шару
function addMaskToSel() {
    var d = new ActionDescriptor(); d.putReference(cTID('null'), maskChanRef()); d.putReference(cTID('T   '), selRef());
    executeAction(cTID('Add '), d, DialogModes.NO);
}
// виділення = маска активного шару
function loadMaskAsSel() {
    var d = new ActionDescriptor(); d.putReference(cTID('null'), selRef()); d.putReference(cTID('T   '), maskChanRef());
    executeAction(cTID('setd'), d, DialogModes.NO);
}
// виділення -= канал
function subChanFromSel(ch) {
    var r = new ActionReference(); r.putName(cTID('Chnl'), ch.name);
    var d = new ActionDescriptor(); d.putReference(cTID('null'), r); d.putReference(cTID('From'), selRef());
    executeAction(cTID('Sbtr'), d, DialogModes.NO);
}

// Клік по деталі. Режим $.global.__PM_MODE:
//   replace — тільки ця деталь (клік), add — додати (Shift+клік), remove — прибрати (Alt+клік), toggle — палітра
// Колір: $.global.__PM_HEX або точка Color Sampler (__PM_FROM_SAMPLER — Shift+клік піпеткою ставить семплер)
function actBindHex(doc) {
    var st = readState();
    if (!st || st.docName != doc.name) { alert('Спочатку натисни «Вибір маски».'); return; }
    var mode = $.global.__PM_MODE || 'toggle';
    var hex = $.global.__PM_HEX ? String($.global.__PM_HEX).toUpperCase() : '';
    if ($.global.__PM_FROM_SAMPLER && doc.colorSamplers.length) {
        var smp = doc.colorSamplers[doc.colorSamplers.length - 1];
        try { hex = smp.color.rgb.hexValue.toUpperCase(); } catch (e0) {}
        try { smp.remove(); } catch (e1) {}
    }
    var hexes = st.hexes || [], has = false, i;
    for (i = 0; i < hexes.length; i++) if (hexes[i] == hex) has = true;
    if (mode == 'toggle') mode = has ? 'remove' : 'add';
    if (mode == 'add' && !hexes.length) mode = 'replace';

    var target = selectById(doc, st.targetId), group = findById(doc.layers, st.groupId) || target.parent;
    var cands = maskCandidates(doc, group), shown = null;
    for (var k = 0; k < cands.length; k++) if (cands[k].visible) shown = cands[k];
    var msg = '', out = [];
    if (!hex || (mode == 'add' && has) || (mode == 'remove' && !has)) out = hexes;
    else if (mode == 'replace') out = [hex];
    else if (mode == 'add') out = hexes.concat([hex]);
    else for (i = 0; i < hexes.length; i++) if (hexes[i] != hex) out.push(hexes[i]);

    if (out.length == 0) {
        selectLayer(target);                           // деталей не лишилось → маску прибрати
        if (activeHasUserMask()) { var dd = new ActionDescriptor(); dd.putReference(cTID('null'), maskChanRef()); executeAction(cTID('Dlt '), dd, DialogModes.NO); }
    } else if (out != hexes && mode == 'add' && hasMaskOf(target)) {
        // Shift+клік: шукаємо лише нову деталь і додаємо до готової маски шару (шов закривається як і раніше).
        // Час не залежить від кількості вже вибраних деталей.
        var r = findMaskWithColor(doc, group, hex, PM_FUZZ, shown ? shown.name : null);
        if (!r.mask) {
            try { doc.selection.deselect(); } catch (e3) {}
            msg = 'Колір #' + hex + ' не знайдено в ID-масках групи';
            out = hexes;
        } else {
            selectLayer(target);
            addMaskToSel();                            // + уже готова маска (з закритими швами)
            closeGaps(PM_CLOSE);
            setLayerMask(doc, target, true);
        }
    } else if (out != hexes) {
        var n = selectHexesUnion(doc, group, out, shown ? shown.name : null);
        if (n == 0 || (mode != 'remove' && n < out.length && out.length > hexes.length)) {
            // новий колір не знайдено — маску не чіпаємо
            try { doc.selection.deselect(); } catch (e2) {}
            msg = 'Колір #' + hex + ' не знайдено в ID-масках групи';
            out = hexes;
        } else {
            setLayerMask(doc, target, true);           // один feather на все
        }
    }
    target.name = baseName(target.name) + (out.length ? ' ‹' + out.join('+') + '›' : '');
    if (shown) { forceVisible(shown); selectLayer(shown); }   // маска лишається показаною — клацати далі
    writeState({ active: true, docName: st.docName, groupId: st.groupId, targetId: st.targetId, index: st.index,
                 maskId: st.maskId, maskName: st.maskName, targetName: baseName(target.name),
                 count: st.count, palette: arr(st.palette || []), hexes: arr(out), msg: msg, shown: arr(st.shown || []) });
}

// Під час вибору виділено інший шар → маска тепер лягає на нього (без «Готово»).
// Та сама група — лише нова ціль; інша група — показати її ID-маску. Без алертів: це просто клік по шару.
function actRetarget(doc) {
    var st = readState();
    if (!st || !st.active || st.docName != doc.name) return;
    var layer = doc.activeLayer;
    if (!layer || layer.id == st.targetId || layer.id == st.maskId || isMaskLayer(layer)) return;
    var group = containingGroup(layer);
    if (!group) { st.msg = 'Шар не в групі рендера — маску не прив\'язано'; writeState(st); return; }
    if (group.id == st.groupId) {
        var mask = findById(doc.layers, st.maskId);
        if (mask) { forceVisible(mask); selectLayer(mask); }
        writeState({ active: true, docName: st.docName, groupId: st.groupId, targetId: layer.id, index: st.index,
                     maskId: st.maskId, maskName: st.maskName, targetName: baseName(layer.name),
                     count: st.count, palette: arr(st.palette || []), hexes: arr(tagHexes(layer.name)), shown: arr(st.shown || []),
                     msg: '', switched: true });
        return;
    }
    if (!maskCandidates(doc, group).length) { st.msg = 'Для групи "' + group.name + '" не знайдено ID-маску'; writeState(st); return; }
    // інша група: прибрати показ старої, почати на новій
    var c = maskCandidates(doc, findById(doc.layers, st.groupId) || group);
    for (var i = 0; i < c.length; i++) if (c[i].visible) c[i].visible = false;
    var sh = st.shown || [];
    for (var k = 0; k < sh.length; k++) { var gl = findById(doc.layers, parseInt(sh[k], 10)); if (gl && gl.visible) gl.visible = false; }
    selectLayer(layer);
    $.global.__PM_NEXT = false;
    actPickStart(doc);
}

// Готово: сховати маски, фокус на коригувальному шарі
function actPickEnd(doc) {
    var st = readState();
    writeState({ active: false });
    clearPickCache(doc);
    if (!st || st.docName != doc.name) return;
    var target = selectById(doc, st.targetId);
    var c = maskCandidates(doc, findById(doc.layers, st.groupId) || target.parent);
    for (var i = 0; i < c.length; i++) if (c[i].visible) c[i].visible = false;
    // повернути видимість груп, увімкнених лише для показу маски
    var sh = st.shown || [];
    for (var k = 0; k < sh.length; k++) { var gl = findById(doc.layers, parseInt(sh[k], 10)); if (gl && gl.visible) gl.visible = false; }
    selectLayer(target);
}

function groupPickDialog(srcGroup, tagged, targets) {
    var w = new Window('dialog', 'Part Masks — перенести на групи');
    w.orientation = 'column'; w.alignChildren = 'fill';
    var p1 = w.add('panel', undefined, 'Шари з групи "' + srcGroup.name + '"');
    p1.alignChildren = 'left';
    var layerChecks = [];
    for (var i = 0; i < tagged.length; i++) {
        var cb = p1.add('checkbox', undefined, tagged[i].name); cb.value = true; layerChecks.push(cb);
    }
    var p2 = w.add('panel', undefined, 'Цільові групи  (група → ID-маски)');
    p2.alignChildren = 'left';
    var grpChecks = [];
    for (var j = 0; j < targets.length; j++) {
        var t = targets[j];
        var label = t.group.name + '   →   ' + (t.masks.length ? t.masks.length + ' ID-маск.: ' + t.masks[0].name + (t.masks.length > 1 ? ' …' : '') : '— маску не знайдено');
        var cg = p2.add('checkbox', undefined, label);
        cg.value = t.masks.length > 0; cg.enabled = t.masks.length > 0; grpChecks.push(cg);
    }
    var row = p2.add('group');
    var bAll = row.add('button', undefined, 'Усі'); var bNone = row.add('button', undefined, 'Жодної');
    bAll.onClick = function () { for (var k = 0; k < grpChecks.length; k++) if (grpChecks[k].enabled) grpChecks[k].value = true; };
    bNone.onClick = function () { for (var k = 0; k < grpChecks.length; k++) grpChecks[k].value = false; };
    var p3 = w.add('panel', undefined, 'Якщо колір деталі не знайдено в масці групи');
    p3.alignChildren = 'left';
    var rWarn = p3.add('radiobutton', undefined, 'Додати шар з порожньою маскою і позначкою ⚠ (потім прив\'язати вручну)');
    var rSkip = p3.add('radiobutton', undefined, 'Пропустити групу для цього шару');
    rWarn.value = true;
    var btns = w.add('group'); btns.alignment = 'right';
    btns.add('button', undefined, 'Скасувати', { name: 'cancel' });
    btns.add('button', undefined, 'Перенести', { name: 'ok' });
    if (w.show() != 1) return null;
    var res = { layers: [], groups: [], warnOnMiss: rWarn.value };
    for (var a = 0; a < layerChecks.length; a++) if (layerChecks[a].value) res.layers.push(tagged[a]);
    for (var b = 0; b < grpChecks.length; b++) if (grpChecks[b].value) res.groups.push(targets[b]);
    return res;
}


// Площа виділеного в альфа-каналі (0..1 на піксель, сума)
function chanArea(ch) {
    var doc = app.activeDocument, keep = doc.activeChannels;
    ch.visible = true;
    var h = ch.histogram, a = 0;
    ch.visible = false;
    try { doc.activeChannels = keep; } catch (e) {}
    for (var v = 1; v < 256; v++) a += h[v] * v / 255;
    return a;
}

// Які деталі (кольори ID-маски) покриває готова маска шару: частка деталі під маскою ≥ 50%.
// Бере ту плоску ID-маску групи, де розбиття найчистіше. [] — не вдалося / маска на все.
function detectHexes(doc, group, layer) {
    selectLayer(layer);
    if (!activeHasUserMask()) return [];
    var cands = maskCandidates(doc, group), flat = [];
    for (var i = 0; i < cands.length; i++) if (!isTexturedMask(cands[i])) flat.push(cands[i]);
    if (!flat.length) return [];
    selectLayer(layer); loadMaskAsSel();
    var M = newChan(doc); M.name = '__pm_M'; doc.selection.store(M, SelectionType.REPLACE);
    var C = newChan(doc); C.name = '__pm_C';
    var best = null;
    try {
        for (var k = 0; k < flat.length; k++) {
            // області кольорів цієї маски — з кешу або порахувати один раз
            var pk = 'p|' + flat[k].id, regs = PM_CACHE ? PM_CACHE[pk] : null;
            if (!regs) {
                regs = { list: [], remove: function () {} };
                var pal = maskPalette(doc, flat[k]);
                for (var j = 0; j < pal.length; j++) {
                    if (!selectColor(doc, flat[k], pal[j], PM_FUZZ)) continue;
                    var rc = newChan(doc); rc.name = '__pm_r' + k + '_' + j;
                    doc.selection.store(rc, SelectionType.REPLACE);
                    var A0 = chanArea(rc);
                    if (A0 < 1) { rc.remove(); continue; }
                    regs.list.push({ hex: pal[j], ch: rc, A: A0 });
                    if (PM_CACHE) PM_CACHE['r|' + flat[k].id + '|' + pal[j]] = rc;
                }
                if (PM_CACHE) PM_CACHE[pk] = regs;
            }
            var hexes = [], err = 0, all = 0, full = true;
            for (var q = 0; q < regs.list.length; q++) {
                var rg = regs.list[q];
                doc.selection.load(rg.ch, SelectionType.REPLACE);
                doc.selection.load(M, SelectionType.INTERSECT);
                var B = 0;
                try { doc.selection.bounds; doc.selection.store(C, SelectionType.REPLACE); B = chanArea(C); } catch (eb) { B = 0; }
                var cov = B / rg.A;
                if ($.global.__PM_DBG) $.global.__PM_DBG.push(flat[k].name.substr(0, 22) + ' ' + rg.hex + ' A=' + Math.round(rg.A) + ' B=' + Math.round(B) + ' cov=' + cov.toFixed(2));
                if (cov >= 0.5) hexes.push(rg.hex); else full = false;
                err += Math.min(cov, 1 - cov) * rg.A; all += rg.A;
            }
            if (!PM_CACHE) for (var z = 0; z < regs.list.length; z++) try { regs.list[z].ch.remove(); } catch (ez) {}
            try { doc.selection.deselect(); } catch (ed) {}
            if (!hexes.length || full) continue;               // нічого або все — це не маска деталі
            var score = all ? err / all : 1;
            // точніше — краще; при рівній точності — менше деталей (швидший перенос)
            if (!best || score < best.score - 1e-4 || (Math.abs(score - best.score) <= 1e-4 && hexes.length < best.hexes.length))
                best = { hexes: hexes, score: score };
        }
    } finally {
        try { doc.selection.deselect(); } catch (e1) {}
        M.remove(); C.remove();
    }
    return best ? best.hexes : [];
}

// ── Швидке визначення деталей готової маски ──────────────────────────────────
// Замість десятків операцій з каналами в повному розмірі: ID-маска і маска шару зменшуються
// до PM_DET_W px, частка кожної деталі під маскою рахується по пікселях. Результат той самий
// (поріг 50%), бо для частки площі повна роздільність не потрібна.
var PM_DET_W = 480;
var PM_DET = null;   // кеш міток ID-масок на час переносу

function readRaw(d) {
    var f = new File(Folder.temp + '/pm_det_' + (new Date().getTime() % 1000000) + '.raw');
    d.saveAs(f, new RawSaveOptions(), true);
    f.encoding = 'BINARY'; f.open('r'); var data = f.read(); f.close(); f.remove();
    return data;
}

// Мітка деталі для кожного пікселя зменшеної ID-маски (-1 — шов/фон між кольорами)
function idLabels(doc, mask) {
    var key = 'L' + mask.id;
    if (PM_DET && PM_DET[key]) return PM_DET[key];
    var pal = maskPalette(doc, mask);
    if (!pal.length) return null;
    var W = PM_DET_W, H = Math.max(1, Math.round(W * doc.height.as('px') / doc.width.as('px')));
    var tmp = app.documents.add(doc.width, doc.height, 72, 'pm_det_id', NewDocumentMode.RGB, DocumentFill.WHITE, 1, BitsPerChannelType.EIGHT);
    var data;
    try {
        app.activeDocument = doc;
        mask.duplicate(tmp, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = tmp;
        var top = tmp.layers[0]; if (!top.visible) top.visible = true;
        tmp.flatten();
        tmp.resizeImage(UnitValue(W, 'px'), UnitValue(H, 'px'), 72, ResampleMethod.NEARESTNEIGHBOR);
        data = readRaw(tmp);
    } finally {
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = doc;
    }
    var rgb = [];
    for (var i = 0; i < pal.length; i++) { var c = new SolidColor(); c.rgb.hexValue = pal[i]; rgb.push([c.rgb.red, c.rgb.green, c.rgb.blue]); }
    // Мітки — рядок (код символу = мітка+1): у ExtendScript push у великий масив квадратичний (230 тис. → хвилини)
    var chunks = [], buf = [], A = [], byKey = {};
    for (var q = 0; q < pal.length; q++) A.push(0);
    for (var p = 0; p + 2 < data.length; p += 3) {
        var r = data.charCodeAt(p), g = data.charCodeAt(p + 1), b = data.charCodeAt(p + 2), k = r * 65536 + g * 256 + b;
        var li = byKey[k];
        if (li === undefined) {   // кожен унікальний колір класифікуємо один раз
            li = -1; var bestD = 40;
            for (var j = 0; j < rgb.length; j++) {
                var dd = Math.abs(rgb[j][0] - r) + Math.abs(rgb[j][1] - g) + Math.abs(rgb[j][2] - b);
                if (dd < bestD) { bestD = dd; li = j; }
            }
            byKey[k] = li;
        }
        buf[buf.length] = li + 1;
        if (buf.length == 2000) { chunks[chunks.length] = String.fromCharCode.apply(null, buf); buf = []; }
        if (li >= 0) A[li]++;
    }
    if (buf.length) chunks[chunks.length] = String.fromCharCode.apply(null, buf);
    var res = { W: W, H: H, lab: chunks.join(''), A: A, hex: pal };
    if (PM_DET) PM_DET[key] = res;
    return res;
}

// Маска шару, зменшена до W×H (1 байт сірого на піксель)
function maskSmall(doc, layer, W, H) {
    selectLayer(layer); loadMaskAsSel();
    var M = newChan(doc); M.name = '__pm_dm';
    var data;
    try {
        doc.selection.store(M, SelectionType.REPLACE);
        try { doc.selection.deselect(); } catch (e0) {}
        var keep = !!PM_DET, h = keep ? PM_DET.mdoc : null;
        if (!h) {
            h = app.documents.add(doc.width, doc.height, 72, 'pm_det_m', NewDocumentMode.GRAYSCALE, DocumentFill.WHITE, 1, BitsPerChannelType.EIGHT);
            if (keep) PM_DET.mdoc = h;
        }
        app.activeDocument = h;
        try {
            var black = new SolidColor(); black.rgb.red = black.rgb.green = black.rgb.blue = 0;
            var white = new SolidColor(); white.rgb.red = white.rgb.green = white.rgb.blue = 255;
            h.selection.selectAll(); h.selection.fill(black);
            var r = new ActionReference(); r.putName(cTID('Chnl'), M.name); r.putName(cTID('Dcmn'), doc.name);
            var d = new ActionDescriptor(); d.putReference(cTID('null'), selRef()); d.putReference(cTID('T   '), r);
            var any = true;
            try { executeAction(cTID('setd'), d, DialogModes.NO); h.selection.bounds; } catch (e1) { any = false; }
            if (any) h.selection.fill(white);
            try { h.selection.deselect(); } catch (e2) {}
            var st = h.activeHistoryState;
            h.resizeImage(UnitValue(W, 'px'), UnitValue(H, 'px'), 72, ResampleMethod.BILINEAR);
            data = readRaw(h);
            h.activeHistoryState = st;              // назад до повного розміру — документ знадобиться для наступного шару
        } finally {
            if (!keep) h.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
        }
    } finally {
        try { M.remove(); } catch (e3) {}
    }
    return data;
}

function detectHexesFast(doc, group, layer) {
    if (!layerHasUserMask(layer)) return [];
    var cands = maskCandidates(doc, group), flat = [];
    for (var i = 0; i < cands.length; i++) if (!isTexturedMask(cands[i])) flat.push(cands[i]);
    if (!flat.length) return [];
    var best = null, mk = null, mkW = 0;
    for (var k = 0; k < flat.length; k++) {
        var L = idLabels(doc, flat[k]);
        if (!L) continue;
        if (!mk || mkW != L.W) { mk = maskSmall(doc, layer, L.W, L.H); mkW = L.W; }
        var S = [];
        for (var q = 0; q < L.hex.length; q++) S.push(0);
        var n = Math.min(L.lab.length, mk.length);
        var lab = L.lab;
        for (var p = 0; p < n; p++) { var li = lab.charCodeAt(p) - 1; if (li >= 0) S[li] += mk.charCodeAt(p); }
        var hexes = [], err = 0, all = 0, full = true;
        for (var q2 = 0; q2 < L.hex.length; q2++) {
            var A = L.A[q2];
            if (A < 3) continue;                    // кілька пікселів — не деталь
            var cov = S[q2] / 255 / A;
            if ($.global.__PM_DBG) $.global.__PM_DBG.push(flat[k].name.substr(0, 22) + ' ' + L.hex[q2] + ' A=' + A + ' cov=' + cov.toFixed(2));
            if (cov >= 0.5) hexes.push(L.hex[q2]); else full = false;
            err += Math.min(cov, 1 - cov) * A; all += A;
        }
        if (!hexes.length || full) continue;        // нічого або все — це не маска деталі
        var score = all ? err / all : 1;
        if (!best || score < best.score - 1e-4 || (Math.abs(score - best.score) <= 1e-4 && hexes.length < best.hexes.length))
            best = { hexes: hexes, score: score };
    }
    return best ? best.hexes : [];
}

function actApply(doc) {
    PM_CACHE = {}; PM_HELP = {}; PM_DET = {};
    clearPickCache(doc);
    try { actApplyInner(doc); } finally {
        clearCache(doc); closeHelpers(doc);
        try { if (PM_DET && PM_DET.mdoc) PM_DET.mdoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
        PM_DET = null;
        try { app.activeDocument = doc; } catch (e2) {}
    }
}

function actApplyInner(doc) {
    var src = containingGroup(doc.activeLayer);
    if (!src) { alert('Виділи шар у групі-джерелі.'); return; }

    var tagged = [], detected = [], undetected = [], noMask = [];
    var srcLayers = groupArtLayers(src, []);                    // знизу вгору — порядок збережеться
    for (var i = 0; i < srcLayers.length; i++) {
        var l = srcLayers[i];
        if (isMaskLayer(l)) continue;
        if (TAG_RE.test(l.name)) { tagged.push(l); continue; }   // ⚠-шари теж: мітка дійсна для інших груп
        // готова маска без мітки (зроблена раніше вручну) → визначити деталі.
        // Тільки корекції (шари або папки корекцій): піксельні шари (копії рендера) переносити не можна.
        if (!isCorrection(l)) continue;
        selectLayer(l);
        if (!activeHasUserMask()) { noMask.push(l.name); continue; }
        var hx;
        try { hx = detectHexesFast(doc, src, l); }
        catch (ef) { hx = detectHexes(doc, src, l); }   // запасний (повільний) шлях
        if (hx.length) {
            l.name = baseName(l.name) + ' ‹' + hx.join('+') + '›';
            tagged.push(l); detected.push(baseName(l.name) + ' → ' + hx.length + ' дет.');
        } else undetected.push(l.name);
    }
    var why = '';
    if (undetected.length) why += '\n\nМаску не вдалося звести до деталей (покриває <50% кожної деталі або все зображення):\n  • ' + undetected.join('\n  • ');
    if (noMask.length) why += '\n\nКорекції без маски (діють на весь рендер, не переносяться):\n  • ' + noMask.join('\n  • ');
    if (tagged.length == 0) { alert('У групі "' + src.name + '" немає шарів з маскою деталей.\nЗроби маску через «Вибір маски» або намалюй її — інструмент сам визначить деталі.' + why); return; }

    var groups = contentGroups(doc), targets = [];
    for (var g = 0; g < groups.length; g++) {
        if (groups[g] == src) continue;
        targets.push({ group: groups[g], masks: maskCandidates(doc, groups[g]) });
    }
    if (targets.length == 0) { alert('Немає інших груп.'); return; }

    // Маска-джерело для кожного шару (щоб у цілях першою пробувати схожу)
    var srcMaskName = {};
    for (var s0 = 0; s0 < tagged.length; s0++) {
        var hx = tagHexes(tagged[s0].name)[0];
        var rs = findMaskWithColor(doc, src, hx, PM_FUZZ, null);
        srcMaskName[tagged[s0].name] = rs.mask ? rs.mask.name : null;
    }
    try { doc.selection.deselect(); } catch (e0) {}

    var pick;
    if ($.global.__PM_AUTO) {   // без діалогу (тест): усі шари, усі групи з маскою, ⚠ при промаху
        pick = { layers: tagged, groups: [], warnOnMiss: true };
        var only = $.global.__PM_ONLY_GROUPS || null;   // тест: лише ці групи
        for (var t = 0; t < targets.length; t++) {
            if (only) { var ok = false; for (var o = 0; o < only.length; o++) if (targets[t].group.name == only[o]) ok = true; if (!ok) continue; }
            if (targets[t].masks.length) pick.groups.push(targets[t]);
        }
    } else pick = groupPickDialog(src, tagged, targets);
    if (!pick || pick.layers.length == 0 || pick.groups.length == 0) return;

    var okList = [], warnList = [], skipList = [], errList = [], dupeList = [];
    for (var ti = 0; ti < pick.groups.length; ti++) {
        var tg = pick.groups[ti].group;
        // наявні перенесені шари цілі: назва → список знизу вгору (однакові назви зіставляються по порядку)
        var exByName = {}, occ = {};
        var tgLayers = groupArtLayers(tg, []);
        for (var e0 = 0; e0 < tgLayers.length; e0++) {
            var el0 = tgLayers[e0];
            if (TAG_RE.test(el0.name)) {   // шар або папка з міткою
                var b0 = baseName(el0.name);
                (exByName[b0] = exByName[b0] || []).push(el0);
            }
        }
        for (var li = 0; li < pick.layers.length; li++) {
            var sl = pick.layers[li];
            var hexes = tagHexes(sl.name), pref = srcMaskName[sl.name];
            var label = tg.name + ' ← ' + baseName(sl.name);
            try {
                if (!pick.groups[ti].masks.length) { skipList.push(label + ' (нема ID-маски)'); continue; }

                // Існуючий шар з тією ж назвою (без ⚠) → оновити на його місці
                var bn = baseName(sl.name), n0 = occ[bn] || 0;
                occ[bn] = n0 + 1;
                var existing = (exByName[bn] && exByName[bn][n0]) ? exByName[bn][n0] : null;   // 1-й з 1-м, 2-й з 2-м
                var anchor = existing;
                if (!anchor) {
                    for (var a = 0; a < tg.layers.length; a++) if (!isMaskLayer(tg.layers[a])) { anchor = tg.layers[a]; break; }
                }
                var dup = anchor ? sl.duplicate(anchor, ElementPlacement.PLACEBEFORE)
                                 : sl.duplicate(tg, ElementPlacement.INSIDE);
                // один прохід пошуку кольорів — після дублювання
                var nFound = selectHexesUnion(doc, tg, hexes, pref);
                var found = nFound > 0;
                if (found && nFound < hexes.length) label += ' (знайдено ' + nFound + ' з ' + hexes.length + ' деталей)';
                if (!found && !pick.warnOnMiss) { dup.remove(); skipList.push(label + ' (кольору нема)'); continue; }
                setLayerMask(doc, dup, found);
                dup.name = (found ? '' : WARN) + sl.name.replace(/^⚠\s*/, '');
                if (existing) existing.remove();
                try { var sv = amVisible(sl); if (amVisible(dup) != sv) amSetVisible(dup, sv); } catch (ev) {}   // «око» як у джерелі
                if (!existing) {   // у цілі вже є своя корекція з такою назвою (не з переносу) — може задвоїтись
                    for (var dq0 = 0; dq0 < tgLayers.length; dq0++)
                        if (!TAG_RE.test(tgLayers[dq0].name) && tgLayers[dq0].name == bn) { dupeList.push(tg.name + ': «' + bn + '»'); break; }
                }
                (found ? okList : warnList).push(label);
            } catch (e) {
                errList.push(label + ' (' + e.message + ')');
            }
        }
    }
    try { selectLayer(pick.layers[pick.layers.length - 1]); } catch (e3) {}

    var r = '═══ PART MASKS — ЗВІТ ═══\n\n';
    if (detected.length) { r += 'Деталі визначено з готових масок (' + detected.length + '):\n'; for (var dq = 0; dq < detected.length; dq++) r += '  ◆ ' + detected[dq] + '\n'; r += '\n'; }
    function sect(t, arr, mk) { if (arr.length) { r += t + ' (' + arr.length + '):\n'; for (var q = 0; q < arr.length; q++) r += '  ' + mk + ' ' + arr[q] + '\n'; r += '\n'; } }
    sect('Не перенесено — деталі не визначено, зроби через «Вибір маски»', undetected, '✗');
    sect('Корекції без маски — не переносились', noMask, '·');
    sect('Перенесено — колір знайдено', okList, '✓');
    sect('Колір НЕ знайдено — шар з порожньою маскою ⚠', warnList, '⚠');
    sect('Пропущено', skipList, '–');
    sect('Помилки', errList, '✗');
    sect('У цілі вже була своя корекція з такою ж назвою — перевір, чи не задвоїлась', dupeList, '⚠');
    if (warnList.length) r += 'Для ⚠: виділи шар → «Вибір маски» → піпеткою по деталі.';
    alert(r);
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (PM_ACTION == 'none') {
    // бібліотечний режим (тести) — нічого не виконуємо
} else if (app.documents.length == 0) {
    alert('Немає відкритих документів.');
} else {
    var doc = app.activeDocument;
    var origUnits = app.preferences.rulerUnits;
    var origDialogs = app.displayDialogs;
    app.preferences.rulerUnits = Units.PIXELS;
    app.displayDialogs = DialogModes.NO;   // жодних вікон Feather / Color Range
    try {
        if (PM_ACTION == 'toggle') actToggle(doc);
        else if (PM_ACTION == 'pick_start') actPickStart(doc);
        else if (PM_ACTION == 'pick_end') actPickEnd(doc);
        else if (PM_ACTION == 'retarget') actRetarget(doc);
        else if (PM_ACTION == 'bind_hex') doc.suspendHistory('Part Masks: прив\'язати', 'actBindHex(doc)');
        else if (PM_ACTION == 'bind') {
            PM_BIND = isAdjustment(doc.activeLayer) ? resolveBindColor(doc) : null;
            doc.suspendHistory('Part Masks: прив\'язати', 'actBind(doc)');
        }
        else doc.suspendHistory('Part Masks: перенести', 'actApply(doc)');
    } catch (e) {
        alert('Part Masks: ' + e.message + (e.line ? ' (рядок ' + e.line + ')' : ''));
    } finally {
        app.preferences.rulerUnits = origUnits;
        app.displayDialogs = origDialogs;
    }
}
