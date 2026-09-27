"""Technical indicators. No future bars."""
from __future__ import annotations

def sma(values, n):
    out = [None] * len(values)
    s = 0.0
    cnt = 0
    for i, v in enumerate(values):
        if v is None:
            cnt = 0
            s = 0.0
            continue
        s += v
        cnt += 1
        if cnt > n:
            prev = values[i - n]
            if prev is None:
                cnt = 1
                s = v
            else:
                s -= prev
                cnt = n
        if cnt >= n:
            out[i] = s / n
    return out


def rsi(closes, n=14):
    out = [None] * len(closes)
    gains, losses = [], []
    for i in range(1, len(closes)):
        if closes[i] is None or closes[i - 1] is None:
            gains.append(None)
            losses.append(None)
            continue
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    if len(gains) < n:
        return out
    ag = sum(g for g in gains[:n] if g is not None)
    al = sum(l for l in losses[:n] if l is not None)
    for i in range(n, len(gains)):
        if i == n:
            avg_g = ag / n
            avg_l = al / n
        else:
            g = gains[i] if gains[i] is not None else 0.0
            l = losses[i] if losses[i] is not None else 0.0
            avg_g = (avg_g * (n - 1) + g) / n
            avg_l = (avg_l * (n - 1) + l) / n
        rs = avg_g / avg_l if avg_l else None
        val = 100.0 - 100.0 / (1.0 + rs) if rs is not None else 100.0
        out[i + 1] = val
    return out


def atr(highs, lows, closes, n=14):
    trs = [None] * len(closes)
    for i in range(len(closes)):
        if highs[i] is None or lows[i] is None or closes[i] is None:
            continue
        if i == 0 or closes[i - 1] is None:
            trs[i] = highs[i] - lows[i]
        else:
            trs[i] = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
    return sma(trs, n)


def macd_hist(closes, fast=12, slow=26, signal=9):
    def ema(vals, n):
        out = [None] * len(vals)
        k = 2 / (n + 1)
        prev = None
        for i, v in enumerate(vals):
            if v is None:
                continue
            prev = v if prev is None else (v * k + prev * (1 - k))
            out[i] = prev
        return out
    ef, es = ema(closes, fast), ema(closes, slow)
    line = [None if a is None or b is None else a - b for a, b in zip(ef, es)]
    sig = ema(line, signal)
    hist = [None if a is None or b is None else a - b for a, b in zip(line, sig)]
    return line, sig, hist


def wilson_ci(wins, n, z=1.96):
    if n <= 0:
        return None, None
    p = wins / n
    den = 1 + z * z / n
    centre = p + z * z / (2 * n)
    adj = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
    lo = max(0.0, (centre - adj) / den)
    hi = min(1.0, (centre + adj) / den)
    return lo, hi
