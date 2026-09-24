// Things that stand on the ground around the viewer: forests and grass on an
// Earth-like world, boulders and slabs and ice blocks everywhere else. The
// ground is divided into cells; each cell, from its own hash and the same
// noise that paints the terrain (trees stand where the ground shader draws
// forest), decides once whether anything grows or lies there, how big and
// which way round. A window of cells follows the camera; cells are worked out
// when they come into it and remembered, and every instance is drawn in one
// call per kind. The robot bumps into the same trunks and boulders it sees.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, hash, terrainHeight, TerrainParams } from '../terrain';
import type { WorldLook } from '../worlds';

interface Layer { cell: number; grid: number; seed: number; maxAlt: number }
const TREES: Layer = { cell: 10, grid: 64, seed: 11, maxAlt: 2500 };
const GRASS: Layer = { cell: 0.6, grid: 96, seed: 23, maxAlt: 40 };
const PEBBLES: Layer = { cell: 3, grid: 60, seed: 37, maxAlt: 150 };
const BOULDERS: Layer = { cell: 22, grid: 36, seed: 51, maxAlt: 3000 };

/** One thing in one cell. */
interface Thing { x: number; z: number; y: number; size: number; rot: number; tilt: number; tint: number; variant: number }

const sm = (a: number, b: number, v: number) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };

// ---------------------------------------------------------------------------
// Geometry: a spruce, a broadleaf tree, a tuft of grass, a rock of each kind.
// ---------------------------------------------------------------------------

function colored(geo: THREE.BufferGeometry, rgb: [number, number, number], jitter = 0): THREE.BufferGeometry {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const k = 1 + ((Math.sin(i * 12.9898) * 43758.5453) % 1) * jitter;
        col[i * 3] = rgb[0] * k; col[i * 3 + 1] = rgb[1] * k; col[i * 3 + 2] = rgb[2] * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const total = parts.reduce((s, p) => s + p.attributes.position.count, 0);
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
    let o = 0;
    for (const p of parts) {
        pos.set(p.attributes.position.array as Float32Array, o * 3);
        nor.set(p.attributes.normal.array as Float32Array, o * 3);
        col.set(p.attributes.color.array as Float32Array, o * 3);
        o += p.attributes.position.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
}

/** Push vertices of a blob about by noise, so crowns and rocks are not perfect solids. */
function lumpy(source: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
    // Weld the faces together first, so the surface stays closed and smooth.
    source.deleteAttribute('normal');
    source.deleteAttribute('uv');
    const geo = mergeVertices(source);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const n = Math.sin(v.x * 7.1 + seed) * Math.sin(v.y * 6.3 + seed * 1.3) * Math.sin(v.z * 8.7 + seed * 0.7);
        v.multiplyScalar(1 + n * amount);
        p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
}

/** Height 1: scaled per instance. Trunk at the origin. */
function spruce(): THREE.BufferGeometry {
    const parts = [colored(new THREE.CylinderGeometry(0.018, 0.03, 0.3, 6).translate(0, 0.15, 0), [0.09, 0.055, 0.03])];
    for (let i = 0; i < 4; i++) {
        const r = 0.22 - i * 0.045, h = 0.34 - i * 0.04, y = 0.2 + i * 0.19;
        parts.push(colored(new THREE.ConeGeometry(r, h, 8, 1).translate(0, y + h / 2, 0), [0.018, 0.045, 0.02], 0.3));
    }
    return merge(parts);
}

function broadleaf(): THREE.BufferGeometry {
    const parts = [colored(new THREE.CylinderGeometry(0.025, 0.045, 0.5, 6).translate(0, 0.25, 0), [0.1, 0.07, 0.045])];
    const blobs: [number, number, number, number][] = [[0, 0.62, 0, 0.26], [0.16, 0.55, 0.05, 0.18], [-0.14, 0.58, -0.06, 0.19], [0.02, 0.8, 0.02, 0.17], [-0.03, 0.55, 0.16, 0.16]];
    blobs.forEach(([x, y, z, r], k) => {
        const geo = lumpy(new THREE.IcosahedronGeometry(r, 1), 0.12, k * 2.1);
        parts.push(colored(geo.translate(x, y, z), [0.035, 0.075, 0.022], 0.35));
    });
    return merge(parts);
}

/** Six crossed blades, each a thin triangle leaning outwards. Height 1. */
function tuft(): THREE.BufferGeometry {
    const pos: number[] = [], nor: number[] = [], col: number[] = [];
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + i * 0.7;
        const r = 0.05 + (i % 3) * 0.04;
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
        const tx = Math.cos(a + Math.PI / 2) * 0.03, tz = Math.sin(a + Math.PI / 2) * 0.03;
        const lean = 0.25 + (i % 2) * 0.2;
        const h = 0.7 + (i % 3) * 0.15;
        pos.push(cx - tx, 0, cz - tz, cx + tx, 0, cz + tz, cx * (1 + lean * 4), h, cz * (1 + lean * 4));
        for (let k = 0; k < 3; k++) nor.push(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3);
        col.push(0.04, 0.08, 0.02, 0.04, 0.08, 0.02, 0.16, 0.23, 0.06);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
}

function rock(shape: WorldLook['rocks']['shape'], detail: number): THREE.BufferGeometry {
    let g: THREE.BufferGeometry = lumpy(new THREE.IcosahedronGeometry(0.5, detail), shape === 'pebble' ? 0.08 : 0.22, shape === 'ice' ? 4.2 : 1.7);
    if (shape === 'slab') g.scale(1.4, 0.28, 1.1);
    else if (shape === 'ice') g.scale(0.9, 1.1, 0.8);
    else if (shape === 'pebble') g.scale(1, 0.6, 1);
    else g.scale(1, 0.72, 0.9);
    if (shape === 'ice' || shape === 'slab') { g = g.toNonIndexed(); g.computeVertexNormals(); } // faceted
    return colored(g, [1, 1, 1], 0.15);
}

// ---------------------------------------------------------------------------

/** A window of cells around the camera, remembered as it moves, drawn as instances. */
class Field {
    private cache = new Map<string, Thing | null>();
    private origin = { i: NaN, j: NaN };
    readonly meshes: THREE.InstancedMesh[];
    private m = new THREE.Matrix4();
    private q = new THREE.Quaternion();
    private e = new THREE.Euler();
    private v = new THREE.Vector3();
    private s = new THREE.Vector3();
    private c = new THREE.Color();

    constructor(scene: THREE.Scene, readonly layer: Layer, geos: THREE.BufferGeometry[], mat: THREE.Material, private evaluate: (i: number, j: number) => Thing | null) {
        const n = layer.grid * layer.grid;
        this.meshes = geos.map(g => {
            const mesh = new THREE.InstancedMesh(g, mat, n);
            mesh.count = 0;
            mesh.frustumCulled = false;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            scene.add(mesh);
            return mesh;
        });
    }

    at(i: number, j: number): Thing | null {
        const key = `${i},${j}`;
        let t = this.cache.get(key);
        if (t === undefined) {
            t = this.evaluate(i, j);
            this.cache.set(key, t);
        }
        return t;
    }

    update(x: number, z: number, visible: boolean) {
        for (const mesh of this.meshes) mesh.visible = visible;
        if (!visible) return;
        const L = this.layer;
        const i0 = Math.floor(x / L.cell) - (L.grid >> 1), j0 = Math.floor(z / L.cell) - (L.grid >> 1);
        if (i0 === this.origin.i && j0 === this.origin.j) return;
        this.origin = { i: i0, j: j0 };
        const counts = this.meshes.map(() => 0);
        for (let j = j0; j < j0 + L.grid; j++) {
            for (let i = i0; i < i0 + L.grid; i++) {
                const t = this.at(i, j);
                if (!t) continue;
                const k = t.variant % this.meshes.length;
                const mesh = this.meshes[k];
                this.e.set(t.tilt, t.rot, t.tilt * 0.6);
                this.q.setFromEuler(this.e);
                this.m.compose(this.v.set(t.x, t.y, t.z), this.q, this.s.setScalar(t.size));
                mesh.setMatrixAt(counts[k], this.m);
                mesh.setColorAt(counts[k], this.c.setScalar(t.tint));
                counts[k]++;
            }
        }
        this.meshes.forEach((mesh, k) => {
            mesh.count = counts[k];
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        });
        // Forget cells long left behind.
        if (this.cache.size > L.grid * L.grid * 4) {
            for (const key of this.cache.keys()) {
                const [i, j] = key.split(',').map(Number);
                if (i < i0 - L.grid || i > i0 + 2 * L.grid || j < j0 - L.grid || j > j0 + 2 * L.grid) this.cache.delete(key);
            }
        }
    }

    dispose(scene: THREE.Scene) {
        for (const mesh of this.meshes) { scene.remove(mesh); mesh.geometry.dispose(); mesh.dispose(); }
    }
}

export class Scatter {
    private fields: Field[] = [];
    private trees: Field | null = null;
    private boulders: Field | null = null;
    private materials: THREE.Material[] = [];

    constructor(private scene: THREE.Scene, shared: Record<string, THREE.IUniform>, look: WorldLook, terrain: TerrainParams, sea: number | null) {
        const t = terrain;
        const seaY = sea ?? -1e9;
        const level = (x: number, z: number) => {
            const h0 = terrainHeight(t, x, z, 6), hx = terrainHeight(t, x + 2, z, 6), hz = terrainHeight(t, x, z + 2, 6);
            return 2 / Math.hypot(h0 - hx, 2, h0 - hz);
        };
        const rand = (L: Layer, i: number, j: number) => [0, 17.3, 41.7, 73.1].map(o => hash(i + L.seed + o, j + L.seed + o));
        const time = shared.uTime;
        /** Leaves and blades bend in the wind. */
        const windy = (mat: THREE.Material, amount: number) => {
            mat.onBeforeCompile = sh => {
                sh.uniforms.uTime = time;
                sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
                    vec3 base = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
                    float gust = sin(uTime * 1.7 + base.x * 0.15 + base.z * 0.07) * 0.6 + sin(uTime * 3.1 + base.z * 0.4) * 0.25;
                    transformed.xz += vec2(0.8, 0.3) * gust * ${amount.toFixed(3)} * position.y * position.y;`);
            };
        };

        if (look.flora) {
            const leaves = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
            windy(leaves, 0.03);
            this.materials.push(leaves);
            this.trees = new Field(scene, TREES, [spruce(), broadleaf()], leaves, (i, j) => {
                const gate = hash(i + 3.3, j + 3.3);
                if (gate >= 0.85) return null;
                const r = rand(TREES, i, j);
                const x = (i + 0.15 + 0.7 * r[0]) * TREES.cell, z = (j + 0.15 + 0.7 * r[1]) * TREES.cell;
                const h = terrainHeight(t, x, z);
                if (h < seaY + 6) return null;
                const rel = h / Math.max(t.relief, 1);
                const forest = sm(0.02, 0.18, fbm(x * 0.0021, z * 0.0021, 4)) * sm(0.6, 0.3, rel);
                const want = Math.max(forest * 0.85, 0.035) * sm(0.72, 0.9, level(x, z)) * sm(0.75, 0.6, rel);
                if (gate >= want) return null;
                // Spruces take the heights and the cold, broadleaves the lowlands.
                const spruceTree = hash(i + 9.1, j + 9.1) < sm(0.12, 0.4, rel + (r[3] - 0.5) * 0.3);
                const size = (9 + 15 * r[2] * r[2]) * (spruceTree ? 1.1 : 0.9);
                return { x, z, y: h - 0.3, size, rot: r[3] * Math.PI * 2, tilt: 0, tint: 0.8 + 0.4 * r[1], variant: spruceTree ? 0 : 1 };
            });
            this.fields.push(this.trees);
            const blades = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
            windy(blades, 0.25);
            this.materials.push(blades);
            this.fields.push(new Field(scene, GRASS, [tuft()], blades, (i, j) => {
                const r = rand(GRASS, i, j);
                if (r[3] > 0.9) return null;
                const x = (i + r[0]) * GRASS.cell, z = (j + r[1]) * GRASS.cell;
                const h = terrainHeight(t, x, z);
                if (h < seaY + 8) return null;
                const rel = h / Math.max(t.relief, 1);
                const meadow = (1 - sm(0.02, 0.18, fbm(x * 0.0021, z * 0.0021, 4)) * 0.8) * sm(0.8, 0.9, level(x, z)) * sm(0.7, 0.5, rel);
                if (r[3] > meadow * 0.9) return null;
                return { x, z, y: h - 0.02, size: 0.35 + 0.5 * r[2], rot: r[3] * 40, tilt: 0, tint: 0.75 + 0.5 * r[1], variant: 0 };
            }));
        }
        const rk = look.rocks;
        if (rk.density > 0) {
            const stone = new THREE.MeshStandardMaterial({ vertexColors: true, color: new THREE.Color(...rk.color), roughness: rk.shape === 'ice' ? 0.35 : 0.95, metalness: 0, flatShading: rk.shape === 'ice' || rk.shape === 'slab' });
            this.materials.push(stone);
            const rocks = (L: Layer, big: boolean, density: number) => (i: number, j: number): Thing | null => {
                const gate = hash(i + 5.1, j + 5.1);
                if (gate > density) return null;
                const r = rand(L, i, j);
                const x = (i + 0.1 + 0.8 * r[0]) * L.cell, z = (j + 0.1 + 0.8 * r[1]) * L.cell;
                const h = terrainHeight(t, x, z);
                if (h < seaY + 0.5) return null;
                // More rocks on slopes and below cliffs.
                if (gate > density * (0.35 + 0.65 * sm(0.98, 0.8, level(x, z)))) return null;
                const size = big ? 2 + 7 * r[2] ** 3 : 0.15 + 1.15 * r[2] ** 3;
                return { x, z, y: h - size * 0.22, size, rot: r[3] * Math.PI * 2, tilt: (r[1] - 0.5) * 0.6, tint: 0.75 + 0.5 * r[1], variant: 0 };
            };
            this.fields.push(new Field(scene, PEBBLES, [rock(rk.shape, 0)], stone, rocks(PEBBLES, false, rk.density)));
            this.boulders = new Field(scene, BOULDERS, [rock(rk.shape, 1)], stone, rocks(BOULDERS, true, rk.density * 0.5));
            this.fields.push(this.boulders);
        }
    }

    /** Follow the camera; `alt` — its height above the ground (high up, the small things are not drawn). */
    update(camera: THREE.Camera, alt: number) {
        for (const f of this.fields) f.update(camera.position.x, camera.position.z, alt < f.layer.maxAlt);
    }

    /** A tree trunk or a big boulder near (x, z), m: its centre and radius, or null. */
    obstacleAt(x: number, z: number): { x: number; z: number; r: number } | null {
        const near = (f: Field | null, radius: (t: Thing) => number) => {
            if (!f) return null;
            const L = f.layer;
            const ci = Math.floor(x / L.cell), cj = Math.floor(z / L.cell);
            for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
                const t = f.at(i, j);
                if (!t) continue;
                const r = radius(t);
                if (r > 0 && Math.hypot(t.x - x, t.z - z) < r + 0.5) return { x: t.x, z: t.z, r };
            }
            return null;
        };
        return near(this.trees, () => 0.45) ?? near(this.boulders, t => (t.size > 3.5 ? t.size * 0.42 : 0));
    }

    dispose() {
        for (const f of this.fields) f.dispose(this.scene);
        for (const m of this.materials) m.dispose();
    }
}
