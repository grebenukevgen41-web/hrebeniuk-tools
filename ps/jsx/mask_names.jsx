/**
 * mask_names.jsx — спільне правило: чи є файл/шар маскою і до якого рендера він належить.
 * Використовують replace_masks.jsx (Update Masks) і part_masks.jsx (Маски деталей).
 *
 * Розуміє (роздільники "_" "." "-" пробіл, номер кадру в кінці, префікс-індекс):
 *   Corona:  2_CMasking_ID_Crosby-front0001, render_CMasking_WireColor0001, x_CMasking_Mask,
 *            CShading_SourceColor / CShading_Albedo (текстурні — маска «приблизна»)
 *   V-Ray:   render.VRayWireColor.0001, render_VRayObjectID, VRayMtlID, VRayRenderID,
 *            VRayMultiMatte / MultiMatteElement, VRayDiffuseFilter (текстурна)
 *   3ds Max: Object ID, Material ID, WireColor, користувацькі Object_Mask / Material_Mask
 *   Blender: _mask_obj / _mask_mat / _mask_face
 *   Загальне: окреме слово mask / masks / masking / matte / id
 */

// Плоскі ID-маски (один колір = одна деталь)
var MN_FLAT_RE = /(cmasking_(?:id|mask|wirecolor)|vray(?:wirecolor|objectid|mtlid|renderid|multimatte|cryptomatte)|multimatte(?:element)?|object[ _]?id|material[ _]?id|mtl[ _]?id|wire[ _]?colou?r|object_mask|material_mask|_mask_(?:obj|mat|face)|(?:^|[._\- ])(?:mask|masks|masking|matte|id)(?=$|[._\- \d]))/i;
// Текстурні (колір матеріалу з текстурою) — працюють з більшим допуском
var MN_TEX_RE = /(cshading_(?:sourcecolor|albedo)|sourcecolor|vraydiffusefilter|diffusefilter|albedo)/i;

function mnNorm(s) {
    s = String(s).toLowerCase().replace(/\.(png|jpe?g|tiff?|tga|exr|psd)$/i, '');
    s = s.replace(/^[._\- ]+|[._\- ]+$/g, '');
    s = s.replace(/[._\- ]*\d{3,}$/, '');          // номер кадру
    s = s.replace(/^[._\- ]+|[._\- ]+$/g, '');
    return s;
}

// null — не маска; інакше { textured, bases: [можливі назви рендера] }
function maskInfo(name) {
    var n = String(name).replace(/\.(png|jpe?g|tiff?|tga|exr|psd)$/i, '');
    var textured = false;
    var m = MN_TEX_RE.exec(n);
    if (m) textured = true; else m = MN_FLAT_RE.exec(n);
    if (!m) return null;
    var before = mnNorm(n.substring(0, m.index));
    var after = mnNorm(n.substring(m.index + m[0].length));
    var bases = [];
    function add(x) { if (x) { for (var i = 0; i < bases.length; i++) if (bases[i] == x) return; bases.push(x); } }
    // "2_CMasking_ID_Crosby" → before "2" (індекс елемента), after "crosby" → спершу змістовна частина
    var bDigits = /^\d+$/.test(before), aDigits = /^\d+$/.test(after);
    if (after && !aDigits) add(after);
    if (before && !bDigits) add(before);
    if (before && after && !bDigits && !aDigits) add(before + '_' + after);
    if (!bases.length) { add(before); add(after); }
    // вид маски (obj / mat / face / wirecolor …) — щоб замінювати маску того ж виду
    return { textured: textured, bases: bases, kind: m[0].toLowerCase().replace(/[^a-z0-9]/g, '') };
}

function isMaskName(name) { return maskInfo(name) !== null; }

// Назва групи/рендера → ключ для порівняння з bases
function groupKey(name) { return mnNorm(name); }
