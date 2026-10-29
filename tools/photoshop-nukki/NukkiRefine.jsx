// 브로애드 누끼 다듬기 (포토샵): 누끼 딴 레이어의 외곽을 안쪽으로 조금 줄이고 매끄럽게 다듬어 레이어 마스크로 가린다.
// 손으로 하던 순서: 레이어 썸네일 Ctrl+클릭(투명도로 선택) → 선택 축소 → 매끄럽게 → (페더) → 레이어 마스크(선택 영역 보이기)
// 원본 픽셀은 지우지 않고 마스크로만 가리므로 나중에 마스크를 고치거나 지우면 원래대로 돌아간다.
// 쓰는 법: 누끼 딴 레이어를 고르고 파일 > 스크립트 > 찾아보기... 에서 이 파일을 고른다.
//          포토샵 Presets/Scripts 폴더에 넣으면 파일 > 스크립트 메뉴에 바로 나오고, 액션·단축키로도 쓸 수 있다.
#target photoshop

var NUKKI_VERSION = '1.0.0';
var NUKKI_SETTINGS_ID = 'broadNukkiRefineSettings';

function nkC(s) { return charIDToTypeID(s); }
function nkS(s) { return stringIDToTypeID(s); }

// 기본값: 출력용(등신대, 스티커 칼선)이라 페더는 0
function nkDefaults() { return { contractPx: 2, smoothPx: 3, featherPx: 0 }; }

function nkLoad() {
  var o = nkDefaults();
  try {
    var d = app.getCustomOptions(NUKKI_SETTINGS_ID);
    o.contractPx = d.getDouble(nkS('contractPx'));
    o.smoothPx = d.getDouble(nkS('smoothPx'));
    o.featherPx = d.getDouble(nkS('featherPx'));
  } catch (e) { /* 처음 쓸 때는 기본값 */ }
  return o;
}

function nkSave(o) {
  var d = new ActionDescriptor();
  d.putDouble(nkS('contractPx'), o.contractPx);
  d.putDouble(nkS('smoothPx'), o.smoothPx);
  d.putDouble(nkS('featherPx'), o.featherPx);
  app.putCustomOptions(NUKKI_SETTINGS_ID, d, true);
}

// 지금 레이어에 레이어 마스크가 있는가
function nkHasMask() {
  var r = new ActionReference();
  r.putEnumerated(nkC('Lyr '), nkC('Ordn'), nkC('Trgt'));
  var d = executeActionGet(r);
  return d.hasKey(nkS('hasUserMask')) && d.getBoolean(nkS('hasUserMask'));
}

function nkDeleteMask() {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putEnumerated(nkC('Chnl'), nkC('Chnl'), nkC('Msk '));
  d.putReference(nkC('null'), r);
  executeAction(nkC('Dlt '), d, DialogModes.NO);
}

// 레이어 썸네일 Ctrl+클릭: 레이어 투명도로 선택
function nkSelectTransparency() {
  var d = new ActionDescriptor(), r = new ActionReference(), t = new ActionReference();
  r.putProperty(nkC('Chnl'), nkC('fsel'));
  d.putReference(nkC('null'), r);
  t.putEnumerated(nkC('Chnl'), nkC('Chnl'), nkC('Trsp'));
  d.putReference(nkC('T   '), t);
  executeAction(nkC('setd'), d, DialogModes.NO);
}

// 선택 영역 보이기로 레이어 마스크
function nkMaskFromSelection() {
  var d = new ActionDescriptor(), r = new ActionReference();
  d.putClass(nkC('Nw  '), nkC('Chnl'));
  r.putEnumerated(nkC('Chnl'), nkC('Chnl'), nkC('Msk '));
  d.putReference(nkC('At  '), r);
  d.putEnumerated(nkC('Usng'), nkC('UsrM'), nkC('RvlS'));
  executeAction(nkC('Mk  '), d, DialogModes.NO);
}

function nkCheck(o) {
  if (!(o.contractPx >= 0 && o.contractPx <= 100)) throw new Error('축소는 0 ~ 100 px 사이로 넣으세요.');
  if (!(o.smoothPx >= 0 && o.smoothPx <= 100)) throw new Error('매끄럽게는 0 ~ 100 px 사이로 넣으세요.');
  if (!(o.featherPx >= 0 && o.featherPx <= 100)) throw new Error('페더는 0 ~ 100 px 사이로 넣으세요.');
}

// 다듬기 본체 (되돌리기 한 번에 되돌아가게 suspendHistory 안에서 부른다)
function nkRefine(o, replaceMask) {
  var doc = app.activeDocument;
  var px = function (v) { return new UnitValue(v, 'px'); };
  if (replaceMask) nkDeleteMask();
  nkSelectTransparency();
  if (o.contractPx > 0) doc.selection.contract(px(o.contractPx));
  if (o.smoothPx >= 1) doc.selection.smooth(Math.round(o.smoothPx)); // 매끄럽게·페더는 px 숫자로 받는다
  if (o.featherPx > 0) doc.selection.feather(o.featherPx);
  nkMaskFromSelection();
  doc.selection.deselect();
}

function nkDialog(o) {
  var w = new Window('dialog', '누끼 다듬기 v' + NUKKI_VERSION);
  w.alignChildren = 'fill';
  var p = w.add('panel', undefined, '외곽 다듬기 (px)');
  p.alignChildren = 'right';
  var row = function (label, value, tip) {
    var g = p.add('group');
    g.add('statictext', undefined, label);
    var e = g.add('edittext', undefined, String(value));
    e.characters = 5;
    e.helpTip = tip;
    return e;
  };
  var eC = row('안쪽으로 축소', o.contractPx, '외곽을 안쪽으로 줄입니다. 배경 테두리가 남은 것을 없앱니다. 1~2px 부터 해 보고 부족하면 늘리세요 (너무 크면 머리카락·손가락 끝이 잘림).');
  var eS = row('매끄럽게', o.smoothPx, '울퉁불퉁한 외곽을 정리합니다 (2~5 추천).');
  var eF = row('페더', o.featherPx, '경계를 부드럽게 합니다. 출력용(등신대, 스티커 칼선)은 0 으로 두세요.');
  w.add('statictext', undefined, '원본은 지우지 않고 레이어 마스크로 가립니다.', { multiline: true });
  var b = w.add('group');
  b.alignment = 'right';
  b.add('button', undefined, '취소', { name: 'cancel' });
  b.add('button', undefined, '확인', { name: 'ok' });
  if (w.show() !== 1) return null;
  return { contractPx: Number(eC.text), smoothPx: Number(eS.text), featherPx: Number(eF.text) };
}

function nkMain() {
  if (app.documents.length === 0) throw new Error('열린 문서가 없습니다.');
  var doc = app.activeDocument, layer = doc.activeLayer;
  if (layer.typename !== 'ArtLayer') throw new Error('누끼 딴 레이어 하나를 고르세요 (그룹 말고).');
  if (layer.isBackgroundLayer) throw new Error('배경 레이어는 투명한 곳이 없습니다. 누끼 딴 레이어를 고르세요.');
  var o = nkDialog(nkLoad());
  if (!o) return;
  nkCheck(o);
  nkSave(o);
  var replace = false;
  if (nkHasMask()) {
    if (!confirm('이 레이어에 이미 마스크가 있습니다.\n지우고 새로 만들까요?')) return;
    replace = true;
  }
  $.global.NUKKI_ARGS = { o: o, replace: replace };
  doc.suspendHistory('누끼 다듬기', 'nkRefine($.global.NUKKI_ARGS.o, $.global.NUKKI_ARGS.replace)');
}

try {
  nkMain();
} catch (e) {
  alert(e.message);
}
