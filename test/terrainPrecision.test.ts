import { describe, expect, it } from 'vitest';
import { hash, terrainHeight, TerrainParams } from '../universe/terrain';

// The ground is drawn by the GPU in float32 and walked on by the CPU in float64. Emulate the
// shader's float32 arithmetic (rounding after every operation) and check that the two agree:
// the robot's feet, the trees and the rocks must sit on the ground that is drawn.
const F = Math.fround;
function noised32(x: number, y: number, out: number[]) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const wx = F(x - ix), wy = F(y - iy);
    const ux = F(wx * wx * wx * F(wx * F(wx * 6 - 15) + 10)), uy = F(wy * wy * wy * F(wy * F(wy * 6 - 15) + 10));
    const dux = F(30 * wx * wx * F(wx * F(wx - 2) + 1)), duy = F(30 * wy * wy * F(wy * F(wy - 2) + 1));
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    const k1 = F(b - a), k2 = F(c - a), k4 = F(F(a - b - c) + d);
    out[0] = F(-1 + 2 * F(a + F(k1 * ux) + F(k2 * uy) + F(k4 * ux * uy)));
    out[1] = F(2 * dux * F(k1 + k4 * uy));
    out[2] = F(2 * duy * F(k2 + k4 * ux));
    return out;
}
const nd = [0, 0, 0];
const step = (x: number, y: number, k: number, ox: number, oy: number): [number, number] =>
    [F(F(F(F(0.8 * x) - F(0.6 * y)) * k) + ox), F(F(F(F(0.6 * x) + F(0.8 * y)) * k) + oy)];
function height32(p: TerrainParams, xM: number, zM: number): number {
    let x = F(F(xM * 0.00008) + p.seed), y = F(F(zM * 0.00008) + F(p.seed * 0.7));
    let bx = F(x * 0.3), by = F(y * 0.3), base = 0, a = 0.5;
    for (let i = 0; i < 4; i++) { base = F(base + a * noised32(bx, by, nd)[0]); [bx, by] = step(bx, by, 2.03, 1.7, 9.2); a *= 0.5; }
    base = F(base + p.seaBias);
    const land = Math.min(1, Math.max(0, (base + 0.05) / 0.4));
    const mask = land * land * (3 - 2 * land);
    let s = 0, b = 0.5, dx = 0, dy = 0;
    for (let i = 0; i < 8; i++) {
        noised32(x, y, nd);
        dx = F(dx + nd[1]); dy = F(dy + nd[2]);
        s = F(s + F(b * nd[0]) / F(1 + dx * dx + dy * dy));
        [x, y] = step(x, y, 2, 3.1, 5.3);
        b *= 0.5;
    }
    return F(p.relief * F(0.55 * base + 0.9 * mask * s));
}

describe('terrain on the GPU and the CPU', () => {
    it('is the same ground to a few centimetres, anywhere within 100 km', () => {
        for (const seed of [11.3, 26.8, 46.8]) {
            const p: TerrainParams = { relief: 3200, craters: false, seed, seaBias: 0.08 };
            let worst = 0;
            for (let k = 0; k < 600; k++) {
                const x = Math.sin(k * 12.9898) * 100_000, z = Math.cos(k * 78.233) * 100_000;
                worst = Math.max(worst, Math.abs(terrainHeight(p, x, z) - height32(p, x, z)));
            }
            expect(worst).toBeLessThan(0.3);
        }
    });

    it('hashes cells into [0, 1)', () => {
        for (let i = -50; i < 50; i++) for (let j = -50; j < 50; j += 7) {
            const h = hash(i, j);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThan(1);
        }
        expect(hash(3, 4)).toBe(hash(3.7, 4.2)); // the cell, not the point
    });
});
