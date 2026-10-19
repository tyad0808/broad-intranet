# 크기 정보 읽기 테스트용 진짜 파일 만들기 (한 번 만들어 저장소에 둔다)
# 실행: python3 tools/file-sync/scripts/make-fixtures.py   (PIL, reportlab, ImageMagick 필요)
import os, subprocess, sys
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

out = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test', 'fixtures', 'file-sync')
os.makedirs(out, exist_ok=True)
p = lambda n: os.path.join(out, n)

# 현수막 3000x900mm PDF 한 쪽
c = canvas.Canvas(p('banner-3000x900.pdf'), pagesize=(3000 * mm, 900 * mm)); c.drawString(100, 100, 'banner'); c.save()
# 명함 90x50mm 2쪽 (앞뒤)
c = canvas.Canvas(p('card-90x50-2p.pdf'), pagesize=(90 * mm, 50 * mm)); c.drawString(10, 10, 'front'); c.showPage(); c.drawString(10, 10, 'back'); c.save()
# 사진: 600x300px, 150dpi (=101.6x50.8mm)
img = Image.new('RGB', (600, 300), (200, 80, 40))
img.save(p('photo-150dpi.jpg'), dpi=(150, 150), quality=60)
img.save(p('photo-72dpi.png'), dpi=(72, 72))
img.save(p('photo-300dpi.tif'), dpi=(300, 300), compression='tiff_deflate')
# 해상도를 cm 단위로 적은 TIFF (40 px/cm = 101.6dpi)
subprocess.run(['convert', '-size', '400x200', 'xc:skyblue', '-units', 'PixelsPerCentimeter', '-density', '40', '-compress', 'Zip', p('cm-units.tif')], check=True)
# 포토샵 PSD 160x80px 200dpi
subprocess.run(['convert', '-size', '160x80', 'xc:green', '-units', 'PixelsPerInch', '-density', '200', '-compress', 'RLE', p('poster-200dpi.psd')], check=True)
# EPS (옛날 AI 와 같은 방식의 범위 표시)
with open(p('logo.eps'), 'w') as f:
    f.write('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 284 142\n%%HiResBoundingBox: 0 0 283.465 141.732\n%%EndComments\nnewpath 0 0 moveto 100 100 lineto stroke\n%%EOF\n')
print('만들었습니다:', sorted(os.listdir(out)))
