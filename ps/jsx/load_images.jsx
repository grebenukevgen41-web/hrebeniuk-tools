/**
 * Load Images to Groups
 * Hrebeniuk_Tools
 *
 * Вибирає папку → в активний документ додає кожне зображення
 * як окрему групу (назва групи = назва файлу).
 * Сортування: по даті МОДИФІКАЦІЇ файлу (не створення — на Windows created
 * ненадійна при копіюванні/перенесенні файлів) — найстаріший внизу, новіший зверху.
 * Всі групи в кінці згортаються.
 */

#target photoshop

var __MN_FILE = new File(new File($.fileName).parent + '/mask_names.jsx');
if (!__MN_FILE.exists) __MN_FILE = new File(Folder.userData + '/HrebeniukTools/jsx/mask_names.jsx');
if (__MN_FILE.exists) $.evalFile(__MN_FILE);

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

// Згорнути групу по ID
// Ключ: putProperty ПЕРШИЙ у ref, потім putIdentifier; значення через "to"
function collapseGroup(id) {
    var desc = new ActionDescriptor();
    var ref  = new ActionReference();
    ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("layerSectionExpanded"));
    ref.putIdentifier(stringIDToTypeID("layer"), id);
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(stringIDToTypeID("to"), false);
    try { executeAction(charIDToTypeID("setd"), desc, DialogModes.NO); } catch (e) {}
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Уся робота — один крок історії: один Ctrl+Z відміняє все
function liMain() {
    var doc    = app.activeDocument;
    var folder = (typeof $.global.__FOLDER !== 'undefined' && $.global.__FOLDER) ? $.global.__FOLDER : Folder.selectDialog("Вибери папку із зображеннями");

    if (folder) {
        var allFiles = folder.getFiles();
        var images   = [];
        var i;
        for (i = 0; i < allFiles.length; i++) {
            if (allFiles[i] instanceof File && isImage(allFiles[i].name) && (typeof $.global.__ONLY === "undefined" || !$.global.__ONLY || $.global.__ONLY[decodeURI(allFiles[i].name)] === 1)) {
                images[images.length] = allFiles[i];
            }
        }

        if (images.length === 0) {
            alert("У вибраній папці немає зображень (jpg, png, tif).");
        } else {

            // Сортування по даті модифікації: найстаріший перший → іде вниз в PS
            images.sort(function(a, b) {
                var da = new Date(a.modified);
                var db = new Date(b.modified);
                return da - db;
            });

            var origUnits = app.preferences.rulerUnits;
            app.preferences.rulerUnits = Units.PIXELS;

            var docW = doc.width.value;
            var docH = doc.height.value;

            var loaded    = [];
            var errors    = [];
            var groupIDs  = []; // збираємо ID груп під час створення

            for (i = 0; i < images.length; i++) {
                var file      = images[i];
                var baseName  = stripExt(file.name);
                var srcDoc;
                try {
                    srcDoc = app.open(file);
                    app.activeDocument = srcDoc;
                    srcDoc.flatten();
                    srcDoc.selection.selectAll();
                    srcDoc.selection.copy();
                    srcDoc.close(SaveOptions.DONOTSAVECHANGES);

                    app.activeDocument = doc;

                    // Створити групу
                    var grp  = doc.layerSets.add();
                    grp.name = baseName;
                    groupIDs[groupIDs.length] = grp.id; // запам'ятати ID

                    // Вставити всередину групи
                    doc.activeLayer = grp;
                    var pasted = doc.paste();
                    pasted.name = baseName;
                    if (typeof isMaskName == "function" && isMaskName(baseName)) pasted.visible = false;   // маска — з вимкненим «оком»

                    // Вписати в розмір канвасу
                    var lw = pasted.bounds[2].value - pasted.bounds[0].value;
                    var lh = pasted.bounds[3].value - pasted.bounds[1].value;
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

                    loaded[loaded.length] = baseName;
                } catch (e) {
                    try { if (srcDoc) srcDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
                    app.activeDocument = doc;
                    errors[errors.length] = baseName + " (" + e.message + ")";
                }
            }

            app.preferences.rulerUnits = origUnits;

            // Тимчасовий шар на корені — щоб activeLayer не тримався всередині групи
            var tempLayer = doc.artLayers.add();
            doc.activeLayer = tempLayer;

            // Спроба 1: collapseAllGroupsEvent (найпростіший)
            var collapsed = false;
            try {
                executeAction(stringIDToTypeID("collapseAllGroupsEvent"), new ActionDescriptor(), DialogModes.NO);
                collapsed = true;
            } catch (e) { collapsed = false; }

            // Спроба 2: по ID з правильною структурою ref
            if (!collapsed) {
                for (var g = 0; g < groupIDs.length; g++) {
                    collapseGroup(groupIDs[g]);
                }
            }

            tempLayer.remove();

            // Звіт
            var report = "═══ LOAD IMAGES — ЗВІТ ═══\n\n";
            report += "Завантажено (" + loaded.length + "), від старого до нового:\n";
            for (var r = 0; r < loaded.length; r++) {
                report += "  \u2713 " + loaded[r] + "\n";
            }
            if (errors.length > 0) {
                report += "\nПомилки (" + errors.length + "):\n";
                for (var er = 0; er < errors.length; er++) {
                    report += "  \u2717 " + errors[er] + "\n";
                }
            }
            alert(report);
        }
    }
}

if (app.documents.length === 0) {
    alert("Немає відкритих документів.");
} else {
    try { app.activeDocument.suspendHistory("Load Images", "liMain()"); }
    catch (e) { alert("Load Images: " + e.message + (e.line ? " (рядок " + e.line + ")" : "")); }
}

$.global.__ONLY = null; // скинути вибір файлів після запуску
