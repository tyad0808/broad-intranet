// 브로애드 자동 누끼 (포토샵): 배경이 복잡한 사진에서 사람(+ 들고 있는 꽃·소품)을 자동으로 골라 등신대용 누끼를 만든다.
// 순서: 원본 레이어 복제 → 피사체 선택(포토샵 AI) → 안쪽으로 축소 → 매끄럽게 → 레이어 마스크 → (투명 PNG 저장) → (확인용 배경)
// 원본 레이어는 숨겨만 두고 지우지 않는다. 되돌리기(Ctrl+Z) 한 번에 전부 되돌아간다.
// 쓰는 법: 사진을 열고 파일 > 스크립트 > 찾아보기... 에서 이 파일을 고른다 (포토샵 2020 이상).
#target photoshop

var NUKKI_AUTO_VERSION = '1.0.0';
var NUKKI_AUTO_SETTINGS_ID = 'broadNukkiAutoSettings';

function naC(s) { return charIDToTypeID(s); }
function naS(s) { return stringIDToTypeID(s); }

// 출력용이라 페더 없음. 축소는 배경(초록 잎 등) 테두리가 남지 않을 만큼만.
function naDefaults() { return { contractPx: 1, smoothPx: 2, savePng: true, checkBg: true }; }

function naLoad() {
  var o = naDefaults();
  try {
    var d = app.getCustomOptions(NUKKI_AUTO_SETTINGS_ID);
    o.contractPx = d.getDouble(naS('contractPx'));
    o.smoothPx = d.getDouble(naS('smoothPx'));
    o.savePng = d.getBoolean(naS('savePng'));
    o.checkBg = d.getBoolean(naS('checkBg'));
  } catch (e) { /* 처음 쓸 때는 기본값 */ }
  return o;
}

function naSave(o) {
  var d = new ActionDescriptor();
  d.putDouble(naS('contractPx'), o.contractPx);
  d.putDouble(naS('smoothPx'), o.smoothPx);
  d.putBoolean(naS('savePng'), o.savePng);
  d.putBoolean(naS('checkBg'), o.checkBg);
  app.putCustomOptions(NUKKI_AUTO_SETTINGS_ID, d, true);
}

function naHasSelection(doc) {
  try { return doc.selection.bounds.length === 4; } catch (e) { return false; }
}

// 선택 > 피사체 (포토샵 AI). 환경설정 > 이미지 처리 > 피사체 선택 을 '클라우드(세부 결과)'로 두면 머리카락·꽃이 더 정확하다.
function naSelectSubject() {
  var d = new ActionDescriptor();
  d.putBoolean(naS('sampleAllLayers'), false);
  executeAction(naS('autoCutout'), d, DialogModes.NO);
}

function naMaskFromSelection() {
  var d = new ActionDescriptor(), r = new ActionReference();
  d.putClass(naC('Nw  '), naC('Chnl'));
  r.putEnumerated(naC('Chnl'), naC('Chnl'), naC('Msk '));
  d.putReference(naC('At  '), r);
  d.putEnumerated(naC('Usng'), naC('UsrM'), naC('RvlS'));
  executeAction(naC('Mk  '), d, DialogModes.NO);
}

// 확인용 단색 배경 (누끼 레이어 바로 아래). 테두리에 남은 배경을 찾기 쉽게 한다. 출력 전에 끄거나 지운다.
function naCheckBackground(doc, cutLayer) {
  var c = new SolidColor();
  c.rgb.red = 255; c.rgb.green = 0; c.rgb.blue = 255;
  var bg = doc.artLayers.add();
  bg.name = '확인용 배경 (출력 전 끄기)';
  doc.selection.selectAll();
  doc.selection.fill(c);
  doc.selection.deselect();
  bg.move(cutLayer, ElementPlacement.PLACEAFTER);
  doc.activeLayer = cutLayer;
}

// 문서 옆에 '<이름>_누끼.png' (투명 배경)로 저장. 보이는 레이어만 들어간다.
function naSavePng(doc) {
  var folder;
  try { folder = doc.path; } catch (e) { folder = Folder.desktop; }
  var base = doc.name.replace(/\.[^\.]+$/, '');
  var f = new File(folder + '/' + base + '_누끼.png');
  var opt = new PNGSaveOptions();
  opt.compression = 6;
  opt.interlaced = false;
  doc.saveAs(f, opt, true, Extension.LOWERCASE);
  return f;
}

function naCheck(o) {
  if (!(o.contractPx >= 0 && o.contractPx <= 50)) throw new Error('축소는 0 ~ 50 px 사이로 넣으세요.');
  if (!(o.smoothPx >= 0 && o.smoothPx <= 50)) throw new Error('매끄럽게는 0 ~ 50 px 사이로 넣으세요.');
}

// 본체 (suspendHistory 안에서 부른다)
function naRun(o) {
  var doc = app.activeDocument;
  var src = doc.activeLayer;
  if (src.isBackgroundLayer) {
    src.isBackgroundLayer = false;
    src.name = '원본';
  }
  var cut = src.duplicate(src, ElementPlacement.PLACEBEFORE);
  cut.name = '누끼';
  src.visible = false;
  doc.activeLayer = cut;

  doc.selection.deselect();
  naSelectSubject();
  if (!naHasSelection(doc)) throw new Error('사람을 찾지 못했습니다. 빠른 선택 도구로 직접 고른 뒤 누끼 다듬기(NukkiRefine)를 쓰세요.');
  if (o.contractPx > 0) doc.selection.contract(new UnitValue(o.contractPx, 'px'));
  if (o.smoothPx >= 1) doc.selection.smooth(Math.round(o.smoothPx));
  naMaskFromSelection();
  doc.selection.deselect();

  $.global.NUKKI_AUTO_PNG = null;
  if (o.savePng) $.global.NUKKI_AUTO_PNG = naSavePng(doc);
  if (o.checkBg) naCheckBackground(doc, cut);
}

function naDialog(o) {
  var w = new Window('dialog', '자동 누끼 v' + NUKKI_AUTO_VERSION);
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
  var eC = row('안쪽으로 축소', o.contractPx, '외곽을 안쪽으로 줄여 남은 배경 테두리를 없앱니다. 1~2px 추천. 크면 머리카락·꽃 끝이 잘립니다.');
  var eS = row('매끄럽게', o.smoothPx, '울퉁불퉁한 외곽 정리 (2~4 추천).');
  var cPng = w.add('checkbox', undefined, '투명 PNG 로 저장 (문서 옆, 이름_누끼.png)');
  cPng.value = o.savePng;
  var cBg = w.add('checkbox', undefined, '확인용 분홍 배경 깔기 (남은 테두리 찾기)');
  cBg.value = o.checkBg;
  w.add('statictext', undefined, '선택한 레이어(사진)를 복제해서 누끼를 땁니다. 원본은 숨겨만 둡니다.', { multiline: true });
  var b = w.add('group');
  b.alignment = 'right';
  b.add('button', undefined, '취소', { name: 'cancel' });
  b.add('button', undefined, '확인', { name: 'ok' });
  if (w.show() !== 1) return null;
  return { contractPx: Number(eC.text), smoothPx: Number(eS.text), savePng: cPng.value, checkBg: cBg.value };
}

function naMain() {
  if (app.documents.length === 0) throw new Error('열린 문서가 없습니다.');
  var doc = app.activeDocument;
  if (doc.activeLayer.typename !== 'ArtLayer') throw new Error('사진 레이어 하나를 고르세요 (그룹 말고).');
  var o = naDialog(naLoad());
  if (!o) return;
  naCheck(o);
  naSave(o);
  $.global.NUKKI_AUTO_ARGS = o;
  doc.suspendHistory('자동 누끼', 'naRun($.global.NUKKI_AUTO_ARGS)');
  var msg = '누끼 완료.\n';
  if ($.global.NUKKI_AUTO_PNG) msg += '저장: ' + decodeURI($.global.NUKKI_AUTO_PNG.fsName) + '\n';
  msg += '빠진 곳·남은 곳은 마스크에 브러시로 고치고(흰색=보이기, 검정=가리기) PNG 를 다시 저장하세요.';
  alert(msg);
}

try {
  naMain();
} catch (e) {
  alert(e.message);
}
