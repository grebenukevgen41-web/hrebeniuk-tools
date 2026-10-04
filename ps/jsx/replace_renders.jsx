/**
 * Replace Renders v2
 * Hrebeniuk_Tools
 *
 * Як v1: вибирає папку → шукає шари в активному PSD за назвою → замінює
 * вміст шару новим файлом.
 *
 * НОВЕ: опційний режим "Знайти/Замінити" — шукає файли за ІНШИМ іменем
 * (напр. шар "24_Legs_shadow_Natural" → файл "24_Legs_shadow_Oak.jpg"),
 * і після заміни перейменовує сам шар і групу, що його містить, за тим
 * самим шаблоном. Без шаблону (чекбокс вимкнено) поведінка ідентична v1.
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

// Регістронезалежний пошук ПЕРШОГО збігу, заміна зі збереженням регістру
// решти рядка. Без regex (ExtendScript має баги з regex literal parsing) —
// тільки indexOf/substring.
function ciReplace(str, find, replace) {
    if (!find) return str;
    var lowerStr  = str.toLowerCase();
    var lowerFind = find.toLowerCase();
    var idx = lowerStr.indexOf(lowerFind);
    if (idx === -1) return str;
    return str.substring(0, idx) + replace + str.substring(idx + find.length);
}

// Згорнути всі групи (collapseAllGroupsEvent — найнадійніший метод для PS 2024)
function collapseAllGroups() {
    var tempLayer = app.activeDocument.artLayers.add();
    app.activeDocument.activeLayer = tempLayer;
    try { executeAction(stringIDToTypeID("collapseAllGroupsEvent"), new ActionDescriptor(), DialogModes.NO); } catch (e) {}
    tempLayer.remove();
}

// Збирає всі ArtLayer-шари рекурсивно. Якщо find задано — шукає файл за
// ПЕРЕТВОРЕНИМ іменем (layer.name з find→replace), а не за оригінальним.
function collectLayers(layers, fileMap, result, find, replace) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.typename == "LayerSet") {
            collectLayers(layer.layers, fileMap, result, find, replace);
        } else if (layer.typename == "ArtLayer") {
            var searchName = find ? ciReplace(layer.name, find, replace) : layer.name;
            var key = searchName.toLowerCase();
            if (fileMap[key] !== undefined) {
                result.push({ layer: layer, file: fileMap[key], key: key });
            }
        }
    }
}

// Збирає всі назви ArtLayer-шарів без збігу (для "не замінено")
function collectUnmatched(layers, fileMap, result, find, replace) {
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.typename == "LayerSet") {
            collectUnmatched(layer.layers, fileMap, result, find, replace);
        } else if (layer.typename == "ArtLayer") {
            var searchName = find ? ciReplace(layer.name, find, replace) : layer.name;
            var key = searchName.toLowerCase();
            if (fileMap[key] === undefined) {
                result.push(layer.name);
            }
        }
    }
}

// Замінює піксельний вміст шару, повертає НОВИЙ (pasted) шар
function replaceLayer(doc, entry) {
    var targetLayer = entry.layer;
    var file        = entry.file;
    var layerName   = targetLayer.name;

    var origUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    var docW = doc.width.value;
    var docH = doc.height.value;

    var srcDoc = app.open(file);
    app.activeDocument = srcDoc;
    srcDoc.flatten();
    srcDoc.selection.selectAll();
    srcDoc.selection.copy();
    srcDoc.close(SaveOptions.DONOTSAVECHANGES);

    app.activeDocument = doc;
    doc.activeLayer = targetLayer;
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

    // порожній шар: PS вставляє прямо в нього — тоді це той самий шар, видаляти не можна
    if (pasted.id != targetLayer.id) targetLayer.remove();
    app.preferences.rulerUnits = origUnits;
    return pasted;
}

// Перейменовує шар і його батьківську групу (якщо є) за шаблоном.
// Ідемпотентно: якщо find вже не знайдено в імені — нічого не робить.
function renameLayerAndGroup(layer, find, replace) {
    if (!find) return;
    layer.name = ciReplace(layer.name, find, replace);
    var parent = layer.parent;
    if (parent && parent.typename == "LayerSet") {
        parent.name = ciReplace(parent.name, find, replace);
    }
}

// ── Діалог ───────────────────────────────────────────────────────────────────

function showOptionsDialog() {
    var dlg = new Window("dialog", "Replace Renders v2");
    dlg.orientation = "column";
    dlg.alignChildren = "fill";
    dlg.margins = 16;
    dlg.spacing = 10;

    dlg.add("statictext", undefined,
        "Натисни «Продовжити», щоб обрати папку з новими рендерами.");

    var panel = dlg.add("panel", undefined, "Перейменування (опційно)");
    panel.orientation = "column";
    panel.alignChildren = "fill";
    panel.margins = 12;
    panel.spacing = 8;

    var chkRename = panel.add("checkbox", undefined,
        "Шукати файли за іншим іменем і перейменувати шари/групи");
    chkRename.value = false;

    var rowFind = panel.add("group");
    rowFind.add("statictext", undefined, "Знайти:").preferredSize.width = 70;
    var txtFind = rowFind.add("edittext", undefined, "");
    txtFind.characters = 22;

    var rowReplace = panel.add("group");
    rowReplace.add("statictext", undefined, "Замінити на:").preferredSize.width = 70;
    var txtReplace = rowReplace.add("edittext", undefined, "");
    txtReplace.characters = 22;

    var hint = panel.add("statictext", undefined,
        "Напр.: шар «24_Legs_Natural» шукатиме файл «24_Legs_Oak»,\n" +
        "і після заміни перейменує шар і групу на «24_Legs_Oak».",
        { multiline: true });
    hint.graphics.font = ScriptUI.newFont(hint.graphics.font.name, "ITALIC", 10);

    txtFind.enabled    = false;
    txtReplace.enabled = false;
    chkRename.onClick = function () {
        txtFind.enabled    = chkRename.value;
        txtReplace.enabled = chkRename.value;
    };

    var btnRow = dlg.add("group");
    btnRow.alignment = "right";
    var btnCancel = btnRow.add("button", undefined, "Скасувати", { name: "cancel" });
    var btnOk     = btnRow.add("button", undefined, "Продовжити", { name: "ok" });

    var result = null;
    btnOk.onClick = function () {
        if (chkRename.value && (!txtFind.text || txtFind.text === "")) {
            alert("Заповни поле «Знайти», або зніми галочку перейменування.");
            return;
        }
        result = {
            rename:  chkRename.value,
            find:    txtFind.text,
            replace: txtReplace.text
        };
        dlg.close();
    };
    btnCancel.onClick = function () { dlg.close(); };

    dlg.show();
    return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Уся робота — один крок історії: один Ctrl+Z відміняє все
function rrMain() {
    var doc = app.activeDocument;

    // uxpAuto ховає ПІЗНІШИЙ preview confirm() (щоб UXP-флоу лишався плавним).
    // __RENAME_OPTIONS_PROVIDED — ОКРЕМИЙ прапорець: якщо UXP-панель сама має
    // поля Find/Replace і явно передала їх — беремо готові значення, без
    // модального ScriptUI діалогу (він не перевірений всередині executeAsModal).
    // Якщо прапорця нема (напр. запуск через File > Scripts напряму) —
    // показуємо звичайний діалог, як завжди.
    var uxpAuto = (typeof $.global.__UXP_AUTO_CONFIRM !== 'undefined' && $.global.__UXP_AUTO_CONFIRM);
    var optionsProvided = (typeof $.global.__RENAME_OPTIONS_PROVIDED !== 'undefined' && $.global.__RENAME_OPTIONS_PROVIDED);
    var opts = optionsProvided
        ? {
            rename:  !!(typeof $.global.__RENAME_FIND !== 'undefined' && $.global.__RENAME_FIND),
            find:    (typeof $.global.__RENAME_FIND    !== 'undefined') ? $.global.__RENAME_FIND    : "",
            replace: (typeof $.global.__RENAME_REPLACE !== 'undefined') ? $.global.__RENAME_REPLACE : ""
          }
        : showOptionsDialog();

    if (opts) {
        var find    = opts.rename ? opts.find    : "";
        var replace = opts.rename ? opts.replace : "";

        var folder = (typeof $.global.__FOLDER !== 'undefined' && $.global.__FOLDER) ? $.global.__FOLDER : Folder.selectDialog("Вибери папку з новими рендерами");

        if (folder) {
            // Зібрати map: назва_lowercase → File
            var fileMap  = {};
            var fileList = []; // для "файли без збігу"
            var allFiles = folder.getFiles();
            for (var i = 0; i < allFiles.length; i++) {
                var f = allFiles[i];
                if (f instanceof File && isImage(f.name)) {
                    var key = stripExt(f.name).toLowerCase();
                    fileMap[key]  = f;
                    fileList[fileList.length] = key;
                }
            }

            if (fileList.length == 0) {
                alert("У вибраній папці немає зображень (jpg, png, tif).");
            } else {
                // Знайти збіги (за трансформованим іменем, якщо є шаблон)
                var matches = [];
                collectLayers(doc.layers, fileMap, matches, find, replace);

                // Файли з папки без збігу в PSD
                var filesNoMatch = [];
                for (var fi = 0; fi < fileList.length; fi++) {
                    var found = false;
                    for (var mi = 0; mi < matches.length; mi++) {
                        if (matches[mi].key == fileList[fi]) { found = true; break; }
                    }
                    if (!found) filesNoMatch[filesNoMatch.length] = fileList[fi];
                }

                if (matches.length == 0) {
                    var msg = "Жодного збігу не знайдено.\n\n";
                    msg += "Файлів у папці: " + fileList.length + "\n";
                    if (find) msg += "Шаблон: «" + find + "» → «" + replace + "»\n";
                    msg += "\nПеревір назви шарів та файлів у папці.";
                    alert(msg);
                } else {
                    // Preview перед заміною
                    var previewMsg = "Буде замінено (" + matches.length + "):\n";
                    for (var j = 0; j < matches.length; j++) {
                        var newName = find ? ciReplace(matches[j].layer.name, find, replace) : matches[j].layer.name;
                        previewMsg += "  ✓ " + matches[j].layer.name;
                        if (find) previewMsg += "  →  " + newName;
                        previewMsg += "\n";
                    }
                    if (filesNoMatch.length > 0) {
                        previewMsg += "\nФайли без збігу в PSD (" + filesNoMatch.length + "):\n";
                        for (var fn = 0; fn < filesNoMatch.length; fn++) {
                            previewMsg += "  – " + filesNoMatch[fn] + "\n";
                        }
                    }
                    previewMsg += "\nПродовжити?";

                    var confirmed = uxpAuto ? true : confirm(previewMsg);
                    if (confirmed) {
                        var replaced   = [];
                        var errorNames = [];

                        for (var k = 0; k < matches.length; k++) {
                            var layerNameSaved = matches[k].layer.name;
                            try {
                                var pastedLayer = replaceLayer(doc, matches[k]);
                                var finalName = layerNameSaved;
                                if (find) {
                                    renameLayerAndGroup(pastedLayer, find, replace);
                                    finalName = pastedLayer.name;
                                }
                                replaced[replaced.length] = (find && finalName !== layerNameSaved)
                                    ? (layerNameSaved + "  →  " + finalName)
                                    : layerNameSaved;
                            } catch (e) {
                                errorNames[errorNames.length] = layerNameSaved + " (" + e.message + ")";
                            }
                        }

                        // Згорнути всі групи після заміни
                        collapseAllGroups();

                        // Шари PSD без збігу з папкою (за трансформованим іменем)
                        var layersNoMatch = [];
                        collectUnmatched(doc.layers, fileMap, layersNoMatch, find, replace);

                        // ── Звіт ──────────────────────────────────────────────
                        var report = "═══ REPLACE RENDERS v2 — ЗВІТ ═══\n\n";
                        if (find) report += "Шаблон: «" + find + "» → «" + replace + "»\n\n";

                        report += "Замінено (" + replaced.length + "):\n";
                        for (var r = 0; r < replaced.length; r++) {
                            report += "  ✓ " + replaced[r] + "\n";
                        }

                        if (errorNames.length > 0) {
                            report += "\nПомилки (" + errorNames.length + "):\n";
                            for (var er = 0; er < errorNames.length; er++) {
                                report += "  ✗ " + errorNames[er] + "\n";
                            }
                        }

                        if (filesNoMatch.length > 0) {
                            report += "\nФайли в папці без збігу в PSD (" + filesNoMatch.length + "):\n";
                            for (var fn2 = 0; fn2 < filesNoMatch.length; fn2++) {
                                report += "  – " + filesNoMatch[fn2] + "\n";
                            }
                        }

                        if (layersNoMatch.length > 0) {
                            report += "\nШари в PSD без збігу в папці (" + layersNoMatch.length + "):\n";
                            for (var ln = 0; ln < layersNoMatch.length; ln++) {
                                report += "  – " + layersNoMatch[ln] + "\n";
                            }
                        }

                        report += "\n───────────────────────────────\n";
                        report += "Файлів у папці: " + fileList.length;
                        report += " | Замінено: " + replaced.length;
                        report += " | Помилок: " + errorNames.length;

                        alert(report);
                    }
                }
            }
        }
    }
}

if (app.documents.length == 0) {
    alert("Немає відкритих документів.");
} else {
    try { app.activeDocument.suspendHistory("Replace Renders", "rrMain()"); }
    catch (e) { alert("Replace Renders: " + e.message + (e.line ? " (рядок " + e.line + ")" : "")); }
}
