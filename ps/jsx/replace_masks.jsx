/**
 * Update Masks
 * Hrebeniuk_Tools
 *
 * Вибирає папку → шукає ТІЛЬКИ файли масок (_mask_obj / _mask_face / _mask_mat).
 * Якщо шар маски з такою назвою вже є в PSD — замінює вміст.
 * Якщо шару нема, але є ГРУПА з іменем базового файлу — створює шар маски
 * всередині неї, завжди зверху групи. Beauty-шари не чіпає взагалі.
 */

#target photoshop

function getExt(name) {
    var parts = name.split(".");
    return parts[parts.length - 1].toLowerCase();
}

function isImage(name) {
    var ext = getExt(name);
    return ext == "jpg" || ext == "jpeg" || ext == "png" ||
           ext == "tif" || ext == "tiff";
}

function stripExt(name) {
    var parts = name.split(".");
    parts.pop();
    return parts.join(".");
}

// Спільне правило «це маска?» (Corona / V-Ray / 3ds Max / Blender) — mask_names.jsx поруч
var __MN_FILE = new File(new File($.fileName).parent + '/mask_names.jsx');
if (!__MN_FILE.exists) __MN_FILE = new File(Folder.userData + '/HrebeniukTools/jsx/mask_names.jsx');
$.evalFile(__MN_FILE);

var MASK_SUFFIXES = ["_mask_obj", "_mask_face", "_mask_mat"];

// Якщо key закінчується на один із суфіксів масок — повертає базове ім'я, інакше null
function matchMaskSuffix(key) {
    for (var i = 0; i < MASK_SUFFIXES.length; i++) {
        var suf = MASK_SUFFIXES[i];
        if (key.length > suf.length && key.substring(key.length - suf.length) == suf) {
            return key.substring(0, key.length - suf.length);
        }
    }
    return null;
}

// Згорнути всі групи (collapseAllGroupsEvent — найнадійніший метод для PS 2024)
function collapseAllGroups() {
    var tempLayer = app.activeDocument.artLayers.add();
    app.activeDocument.activeLayer = tempLayer;
    try { executeAction(stringIDToTypeID("collapseAllGroupsEvent"), new ActionDescriptor(), DialogModes.NO); } catch (e) {}
    tempLayer.remove();
}

// Знаходить ArtLayer з точною назвою (case-insensitive), рекурсивно
function findLayerByName(layers, nameLower) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.typename == "LayerSet") {
            var found = findLayerByName(layer.layers, nameLower);
            if (found) return found;
        } else if (layer.typename == "ArtLayer") {
            if (layer.name.toLowerCase() == nameLower) return layer;
        }
    }
    return null;
}

// Група, чия назва (без номера кадру) збігається з однією з можливих назв рендера маски
function findGroupByBases(layers, bases) {
    for (var b = 0; b < bases.length; b++) {
        var g = findGroupByKey(layers, bases[b]);
        if (g) return g;
    }
    return null;
}
function findGroupByKey(layers, key) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.typename == "LayerSet") {
            if (groupKey(layer.name) == key) return layer;
            var found = findGroupByKey(layer.layers, key);
            if (found) return found;
        }
    }
    return null;
}

// Шукає LayerSet (групу) за назвою (без урахування регістру), рекурсивно
function findGroupByName(layers, nameLower) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.typename == "LayerSet") {
            if (layer.name.toLowerCase() == nameLower) return layer;
            var found = findGroupByName(layer.layers, nameLower);
            if (found) return found;
        }
    }
    return null;
}

// Вставляє файл як шар над поточним активним шаром, вписує в розмір канвасу
function pasteAndFit(doc, file, layerName, docW, docH) {
    var srcDoc = app.open(file);
    app.activeDocument = srcDoc;
    srcDoc.flatten();
    srcDoc.selection.selectAll();
    srcDoc.selection.copy();
    srcDoc.close(SaveOptions.DONOTSAVECHANGES);

    app.activeDocument = doc;
    var pasted = doc.paste();
    pasted.name = layerName;

    var b  = pasted.bounds;
    var lw = b[2].value - b[0].value;
    var lh = b[3].value - b[1].value;
    if (lw > 0 && lh > 0) {
        if (Math.abs(lw - docW) > 1 || Math.abs(lh - docH) > 1) {
            var sc = Math.min(docW / lw, docH / lh) * 100;
            pasted.resize(sc, sc, AnchorPosition.MIDDLECENTER);
        }
        var b2 = pasted.bounds;
        var dx = docW / 2 - (b2[0].value + (b2[2].value - b2[0].value) / 2);
        var dy = docH / 2 - (b2[1].value + (b2[3].value - b2[1].value) / 2);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            pasted.translate(dx, dy);
        }
    }
    pasted.visible = false;   // маски завантажуються з вимкненим «оком»
    return pasted;
}

// Замінює вміст вже існуючого шару маски (лишається на своєму місці)
function replaceMaskLayer(doc, targetLayer, file, docW, docH) {
    var layerName = targetLayer.name;
    doc.activeLayer = targetLayer;
    pasteAndFit(doc, file, layerName, docW, docH);
    targetLayer.remove();
}

// Створює новий шар маски всередині групи, завжди зверху
function createMaskLayer(doc, group, file, layerName, docW, docH) {
    if (group.layers.length == 0) throw new Error("група порожня");
    doc.activeLayer = group.layers[0];
    pasteAndFit(doc, file, layerName, docW, docH);
}

// ── Маски для всіх кольорів ──────────────────────────────────────────────────
// Маска рендериться один раз (в одному кольорі) і лягає в групи ВСІХ кольорів тієї ж моделі/ракурсу:
// назви порівнюються без слів-кольорів зі списку color_words.txt (його можна доповнювати).

var UM_DEFAULT_WORDS =
    "# Слова-кольори: при порівнянні назв маски й групи ці слова викидаються.\n" +
    "# Маска es-ptwca ляже і в групу gr-ptwna тієї ж моделі й ракурсу.\n" +
    "# Додавай свої коди через пробіл або з нового рядка. Рядки з # — коментарі.\n" +
    "# left/right/front/back/34 не викидаються ніколи.\n\n" +
    "# Thuma — дерево\nes gr na oa wa\n" +
    "# Thuma — тканини, шкіра\nleasdl saddle ptwca ptwna ptwiv ptwmo pmwllg pmwlch pmwlmo pmwlna pmwlwh bouch boumo bouna bouwh\n" +
    "# Загальні\nblack white grey gray red blue green brown beige ivory cream natural walnut oak ash espresso\n" +
    "charcoal navy pink yellow orange purple sand taupe olive\n";
var UM_NEVER = { left: 1, right: 1, front: 1, back: 1, '34': 1, top: 1, side: 1 };

function loadColorWords() {
    var dir = new Folder(Folder.userData + '/HrebeniukTools');
    if (!dir.exists) dir.create();
    var f = new File(dir + '/color_words.txt'), txt = '';
    if (!f.exists) { f.encoding = 'UTF-8'; f.open('w'); f.write(UM_DEFAULT_WORDS); f.close(); }
    f.encoding = 'UTF-8';
    if (f.open('r')) { txt = f.read(); f.close(); }
    var words = {}, lines = txt.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/#.*$/, '');
        var w = ln.toLowerCase().split(/[\s,;]+/);
        for (var j = 0; j < w.length; j++) if (w[j] && !UM_NEVER[w[j]]) words[w[j]] = 1;
    }
    return words;
}
var UM_COLORS = loadColorWords();

// Назва рендера без слів-кольорів: "thuma-…-arm-left-es-ptwca-front" → "thuma-…-arm-left-front"
function shapeKey(base) {
    var t = String(base).toLowerCase().split(/[._\- ]+/), out = [];
    for (var i = 0; i < t.length; i++) if (t[i] && !UM_COLORS[t[i]]) out.push(t[i]);
    return out.join('-');
}

function tokList(s) {
    var t = String(s).toLowerCase().split(/[._\- ]+/), out = [];
    for (var i = 0; i < t.length; i++) if (t[i]) out.push(t[i]);
    return out;
}

// Чи підходить маска групі: слова маски (без кольорів) є в назві групи в тому ж порядку,
// а «зайві» слова групи — коди кольорів: зі списку color_words або яких нема в жодній масці папки
// (cushion / detail / side є в масках → це деталь моделі, не колір). Повертає к-сть збігів або -1.
function matchScore(maskTokens, groupTokens, vocab) {
    var j = 0, n = 0;
    for (var i = 0; i < groupTokens.length; i++) {
        var t = groupTokens[i];
        if (j < maskTokens.length && maskTokens[j] == t) { j++; n++; continue; }
        if (UM_COLORS[t]) continue;
        if (UM_NEVER[t] || vocab[t]) return -1;
    }
    return j == maskTokens.length ? n : -1;
}

function allGroups(layers, out) {
    for (var i = 0; i < layers.length; i++) {
        if (layers[i].typename == 'LayerSet') { out.push(layers[i]); allGroups(layers[i].layers, out); }
    }
    return out;
}

// Наявна маска того ж виду безпосередньо в групі (піксельний шар або смарт-об'єкт)
function findKindLayer(group, kind) {
    for (var i = 0; i < group.layers.length; i++) {
        var l = group.layers[i];
        if (l.typename != 'ArtLayer') continue;
        var inf = maskInfo(l.name);
        if (!inf || inf.kind != kind) continue;
        try { if (l.kind != LayerKind.NORMAL && l.kind != LayerKind.SMARTOBJECT) continue; } catch (e) { continue; }
        return l;
    }
    return null;
}

// Файл → буфер обміну (один раз на файл), потім вставляти скільки завгодно
function copyFileToClipboard(file) {
    var srcDoc = app.open(file);
    app.activeDocument = srcDoc;
    srcDoc.flatten();
    srcDoc.selection.selectAll();
    srcDoc.selection.copy();
    srcDoc.close(SaveOptions.DONOTSAVECHANGES);
}
function pasteFit(doc, layerName, docW, docH) {
    app.activeDocument = doc;
    var pasted = doc.paste();
    pasted.name = layerName;
    var b = pasted.bounds, lw = b[2].value - b[0].value, lh = b[3].value - b[1].value;
    if (lw > 0 && lh > 0) {
        if (Math.abs(lw - docW) > 1 || Math.abs(lh - docH) > 1) {
            var sc = Math.min(docW / lw, docH / lh) * 100;
            pasted.resize(sc, sc, AnchorPosition.MIDDLECENTER);
        }
        var b2 = pasted.bounds;
        var dx = docW / 2 - (b2[0].value + (b2[2].value - b2[0].value) / 2);
        var dy = docH / 2 - (b2[1].value + (b2[3].value - b2[1].value) / 2);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) pasted.translate(dx, dy);
    }
    pasted.visible = false;   // маски завантажуються з вимкненим «оком»
    return pasted;
}

// Виділити шар, НЕ вмикаючи йому «око» (doc.activeLayer = прихований шар робить його видимим)
function selectQuiet(layer) {
    var r = new ActionReference(); r.putIdentifier(charIDToTypeID('Lyr '), layer.id);
    var d = new ActionDescriptor(); d.putReference(charIDToTypeID('null'), r);
    d.putBoolean(charIDToTypeID('MkVs'), false);
    executeAction(charIDToTypeID('slct'), d, DialogModes.NO);
}

function umOut(msg) {
    if ($.global.__UM_QUIET) $.global.__UM_REPORT = msg; else alert(msg);
}

// Довгі списки в діалозі — не більше max рядків
function listLines(arr, mk, max) {
    var s = '', n = Math.min(arr.length, max);
    for (var i = 0; i < n; i++) s += '  ' + mk + ' ' + arr[i] + '\n';
    if (arr.length > n) s += '  … і ще ' + (arr.length - n) + '\n';
    return s;
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Уся робота — один крок історії: один Ctrl+Z відміняє всі замінені/додані маски
function umMain() {
    var doc    = app.activeDocument;
    var folder = (typeof $.global.__FOLDER !== 'undefined' && $.global.__FOLDER) ? $.global.__FOLDER : Folder.selectDialog("Вибери папку з масками");

    if (folder) {
        var origUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        var docW = doc.width.value;
        var docH = doc.height.value;

        // Зібрати тільки файли масок, решту ігнорувати
        var maskFiles = []; // { file, key, bases, kind, layerName }
        var allFiles  = folder.getFiles();
        var UM_VOCAB = {};   // слова назв усіх масок папки (без кольорів) — це слова моделей/ракурсів
        for (var vi = 0; vi < allFiles.length; vi++) {
            if (!(allFiles[vi] instanceof File)) continue;
            var vinf = maskInfo(decodeURI(allFiles[vi].name));
            if (!vinf) continue;
            for (var vb = 0; vb < vinf.bases.length; vb++) {
                var vt = tokList(vinf.bases[vb]);
                for (var vk = 0; vk < vt.length; vk++) if (!UM_COLORS[vt[vk]]) UM_VOCAB[vt[vk]] = 1;
            }
        }
        for (var i = 0; i < allFiles.length; i++) {
            var f = allFiles[i];
            if (f instanceof File && isImage(f.name) && (typeof $.global.__ONLY === "undefined" || !$.global.__ONLY || $.global.__ONLY[decodeURI(f.name)] === 1)) {
                var fname = decodeURI(f.name);
                var info = maskInfo(fname);
                if (info) maskFiles.push({ file: f, key: stripExt(fname).toLowerCase(), bases: info.bases, kind: info.kind, layerName: stripExt(fname) });
            }
        }

        if (maskFiles.length == 0) {
            umOut("Серед вибраних файлів немає масок.\n\nМаска впізнається за словом у назві: CMasking_ID / WireColor / Mask, CShading_SourceColor, VRayWireColor / ObjectID / MtlID / MultiMatte, Object/Material ID, _mask_obj/_mat/_face, mask, matte, id.");
        } else {
            // Групи документа: точна назва рендера і «форма» (без кольорів)
            var groups = allGroups(doc.layers, []), gInfo = [];
            for (var gi = 0; gi < groups.length; gi++) {
                var gk = groupKey(groups[gi].name);
                if (gk) gInfo.push({ group: groups[gi], key: gk, toks: tokList(gk) });
            }

            // Для кожної (група, вид маски) — найкращий файл: свого кольору, інакше найточніший тієї ж моделі
            var slots = {}, slotOrder = [], noMatch = [], toReplaceByName = [];
            for (var m = 0; m < maskFiles.length; m++) {
                var mf = maskFiles[m], hit = false;
                mf.toks = [];
                for (var b0 = 0; b0 < mf.bases.length; b0++) {
                    var tl = tokList(mf.bases[b0]), keep = [];
                    for (var t0 = 0; t0 < tl.length; t0++) if (!UM_COLORS[tl[t0]]) keep.push(tl[t0]);
                    mf.toks.push(keep);
                }
                for (var g = 0; g < gInfo.length; g++) {
                    var gi2 = gInfo[g], exact = false, base = null, score = -1;
                    for (var b = 0; b < mf.bases.length; b++) {
                        if (mf.bases[b] == gi2.key) { exact = true; base = mf.bases[b]; score = 1e6; break; }
                        if (!mf.toks[b].length) continue;
                        var sc = matchScore(mf.toks[b], gi2.toks, UM_VOCAB);
                        if (sc > score) { score = sc; base = mf.bases[b]; }
                    }
                    if (score < 0) continue;
                    hit = true;
                    var sk = g + '|' + mf.kind, cur = slots[sk];
                    if (!cur) { slots[sk] = { gi: gi2, mf: mf, base: base, exact: exact, score: score }; slotOrder.push(sk); }
                    else if (score > cur.score) { cur.mf = mf; cur.base = base; cur.exact = exact; cur.score = score; }
                }
                if (!hit) {
                    // стара поведінка: шар з точно такою ж назвою будь-де в документі
                    var ex = findLayerByName(doc.layers, mf.key);
                    if (ex) toReplaceByName.push({ layer: ex, mf: mf });
                    else noMatch.push(mf.layerName);
                }
            }

            // План: по файлах (кожен файл відкривається один раз)
            var plan = [], byFile = {}, keptOwn = [];
            for (var so = 0; so < slotOrder.length; so++) {
                var sl = slots[slotOrder[so]];
                var fk = sl.mf.key;
                var exL = findKindLayer(sl.gi.group, sl.mf.kind);
                // своя маска групи (її колір) не замінюється маскою іншого кольору
                if (exL && !sl.exact) {
                    var ei = maskInfo(exL.name), own = false;
                    for (var eb = 0; eb < ei.bases.length; eb++) if (ei.bases[eb] == sl.gi.key) own = true;
                    if (own) { keptOwn.push(sl.gi.group.name); continue; }
                }
                if (!byFile[fk]) { byFile[fk] = { mf: sl.mf, targets: [] }; plan.push(byFile[fk]); }
                byFile[fk].targets.push({ group: sl.gi.group, exact: sl.exact, existing: exL });
            }

            if (plan.length == 0 && toReplaceByName.length == 0 && keptOwn.length) {
                umOut("Усі знайдені групи вже мають свою маску цього виду (" + keptOwn.length + ") — нічого не змінено.");
            } else if (plan.length == 0 && toReplaceByName.length == 0) {
                app.preferences.rulerUnits = origUnits;
                umOut("Жодного збігу не знайдено.\n\nФайлів масок: " + maskFiles.length + "\n\nПеревір назви груп/шарів у PSD." +
                      "\nКоди кольорів, які ігноруються при порівнянні: " + Folder.userData + "/HrebeniukTools/color_words.txt");
            } else {
                var nRep = 0, nNew = 0, nBorrow = 0, lines = [];
                for (var p = 0; p < plan.length; p++) {
                    var tg = plan[p].targets, names = [];
                    for (var t = 0; t < tg.length; t++) {
                        if (tg[t].existing) nRep++; else nNew++;
                        if (!tg[t].exact) nBorrow++;
                        names.push(tg[t].group.name);
                    }
                    lines.push(plan[p].mf.layerName + '  →  ' + tg.length + ' гр.' + (tg.length <= 3 ? ': ' + names.join(', ') : ': ' + names.slice(0, 2).join(', ') + ' …'));
                }
                for (var rn = 0; rn < toReplaceByName.length; rn++) { nRep++; lines.push(toReplaceByName[rn].mf.layerName + '  →  шар з тією ж назвою'); }

                var previewMsg = "Масок: " + maskFiles.length + "  →  груп: " + (nRep + nNew) + "\n" +
                                 "  замінити наявну маску: " + nRep + "\n  додати нову: " + nNew + "\n" +
                                 (nBorrow ? "  з них назва не точна — підібрано по моделі й ракурсу (кольори пропущено): " + nBorrow + "\n" : "") + "\n" +
                                 listLines(lines, '•', 25);
                if (keptOwn.length) previewMsg += "\nЛишаю свою маску групи (іншим кольором не замінюю): " + keptOwn.length + " гр.\n";
                if (noMatch.length) previewMsg += "\nБез збігу (" + noMatch.length + "):\n" + listLines(noMatch, '–', 10);
                previewMsg += "\nПродовжити?";

                var confirmed = (typeof $.global.__UXP_AUTO_CONFIRM !== 'undefined' && $.global.__UXP_AUTO_CONFIRM) ? true : confirm(previewMsg);
                if (confirmed) {
                    var replaced = 0, created = 0, errorNames = [];

                    for (var pk = 0; pk < plan.length; pk++) {
                        var mfp = plan[pk].mf;
                        try { copyFileToClipboard(mfp.file); }
                        catch (e) { errorNames.push(mfp.layerName + " (не відкрився: " + e.message + ")"); continue; }
                        for (var tk = 0; tk < plan[pk].targets.length; tk++) {
                            var trg = plan[pk].targets[tk];
                            var nm = mfp.layerName;   // назва файлу: видно, звідки маска, і повторний запуск її оновить
                            try {
                                if (trg.existing) {
                                    selectQuiet(trg.existing);
                                    var np = pasteFit(doc, nm, docW, docH);
                                    if (np.id != trg.existing.id) trg.existing.remove();   // порожній шар: вставка лягла в нього самого
                                    np.visible = false;   // remove() перевиділяє шар і вмикає йому «око»
                                    replaced++;
                                } else {
                                    if (trg.group.layers.length == 0) throw new Error("група порожня");
                                    selectQuiet(trg.group.layers[0]);
                                    pasteFit(doc, nm, docW, docH);
                                    created++;
                                }
                            } catch (e) {
                                errorNames.push(nm + " → " + trg.group.name + " (" + e.message + ")");
                            }
                        }
                    }
                    for (var rk = 0; rk < toReplaceByName.length; rk++) {
                        try {
                            copyFileToClipboard(toReplaceByName[rk].mf.file);
                            selectQuiet(toReplaceByName[rk].layer);
                            var np2 = pasteFit(doc, toReplaceByName[rk].layer.name, docW, docH);
                            if (np2.id != toReplaceByName[rk].layer.id) toReplaceByName[rk].layer.remove();
                            np2.visible = false;
                            replaced++;
                        } catch (e) {
                            errorNames.push(toReplaceByName[rk].mf.layerName + " (" + e.message + ")");
                        }
                    }

                    collapseAllGroups();

                    var report = "═══ UPDATE MASKS — ЗВІТ ═══\n\n";
                    report += "Замінено: " + replaced + "   Додано: " + created + "   Помилок: " + errorNames.length + "\n";
                    if (nBorrow) report += "Назва не точна — підібрано по моделі й ракурсу (кольори пропущено): " + nBorrow + " груп\n";
                    report += "\n" + listLines(lines, '✓', 25);
                    if (errorNames.length) report += "\nПомилки (" + errorNames.length + "):\n" + listLines(errorNames, '✗', 15);
                    if (noMatch.length) report += "\nБез збігу (" + noMatch.length + "):\n" + listLines(noMatch, '–', 15);
                    umOut(report);
                }
            }
        }

        app.preferences.rulerUnits = origUnits;
    }
}

if (app.documents.length == 0) {
    alert("Немає відкритих документів.");
} else {
    try { app.activeDocument.suspendHistory("Update Masks", "umMain()"); }
    catch (e) { umOut("Update Masks: " + e.message + (e.line ? " (рядок " + e.line + ")" : "")); }
}

$.global.__ONLY = null; // скинути вибір файлів після запуску
