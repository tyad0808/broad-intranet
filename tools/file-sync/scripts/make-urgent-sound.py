# 급한 알림 소리 만들기: 기본 알림 소리(notify.wav)의 앞부분을 조금 높게, 세 번 빠르게, 조금 크게.
# 실행: python3 scripts/make-urgent-sound.py   (numpy 필요) → src/ui/sounds/urgent.wav
import os, wave
import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, '..', 'src', 'ui', 'sounds', 'notify.wav')
dst = os.path.join(here, '..', 'src', 'ui', 'sounds', 'urgent.wav')

w = wave.open(src)
rate, ch = w.getframerate(), w.getnchannels()
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, ch).astype(np.float32) / 32768
w.close()

# 1) 소리가 센 앞부분 0.6초만 (0.05초부터), 끝은 0.12초 동안 줄여서 뚝 끊기지 않게
start, length = int(rate * 0.05), int(rate * 0.6)
hit = a[start:start + length].copy()
fade = int(rate * 0.12)
hit[-fade:] *= np.linspace(1, 0, fade)[:, None]

# 2) 4반음 높게 (빨라지면서 높아짐)
factor = 2 ** (4 / 12)
n = int(len(hit) / factor)
x = np.linspace(0, len(hit) - 1, n)
hit = np.stack([np.interp(x, np.arange(len(hit)), hit[:, c]) for c in range(ch)], axis=1)

# 3) 세 번 빠르게 (사이 0.07초), 크게 (가장 큰 소리를 0.85 로)
gap = np.zeros((int(rate * 0.07), ch), dtype=np.float32)
out = np.concatenate([hit, gap, hit, gap, hit])
out *= 0.85 / np.abs(out).max()

o = wave.open(dst, 'wb')
o.setnchannels(ch); o.setsampwidth(2); o.setframerate(rate)
o.writeframes((np.clip(out, -1, 1) * 32767).astype(np.int16).tobytes())
o.close()
print('만들었습니다:', dst, round(len(out) / rate, 2), '초')
