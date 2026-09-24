// On foot on a planet. The ship sets down on its landing legs, the ramp comes
// down and the robot walks out; from there it can walk, run, jump (as high as
// the world's gravity allows), fly short hops on its jet pack, shoot, talk to
// the beings who live here and take their jobs, pick up samples, fight what
// roams the surface, and walk back up the ramp to take off again.
// Scene units are metres (the planet level's).

import * as THREE from 'three';
import type { Action } from '../common';
import { virtualKeys } from '../flight';
import { mulberry32 } from '../mandelbrot';
import { pilotState, segmentHits } from './combat';
import { DialogBox } from './creatures';
import type { WorldBrief } from './dialogue';
import { GroundKind, isGround } from './missions';
import { makeShip } from './models';
import { effects, progress } from './progress';
import { Robot } from './robot';
import { Vehicle } from './vehicle';
import { addErrandTo, errandMission, ShipGame } from './shipGame';
import { BeingSpec, CHATTER, FOES, FoeDef, makeBeing, makeFoe, makeItem, makeStructure, Rig, Structure } from './surfaceLife';

export interface SurfaceContext {
    scene: THREE.Scene;
    canvas: HTMLCanvasElement;
    toast: (t: string) => void;
    game: ShipGame;
    /** Ground height (m) at (x, z) m. */
    groundAt: (x: number, z: number) => number;
    /** Sea level, m, or null. */
    sea: number | null;
    gravity: number;
    planet: string;
    /** Key of the star system's mission log, for jobs out in space. */
    systemKey: string;
    world: WorldBrief;
    beings: BeingSpec[];
    foes: GroundKind[];
    itemColor: number;
    dustColor: THREE.Color;
    /** Trunks and boulders to walk round. */
    obstacle: (x: number, z: number) => { x: number; z: number; r: number } | null;
}

export interface SurfaceState {
    ship: [number, number, number, number];
    robot: [number, number, number];
    camYaw: number;
}

const WALK = 4.2, RUN = 8.5;
/** Talking range and how close to the ramp to board, m. */
const TALK_M = 6, BOARD_M = 6;
/** The ship's landing legs reach this far below its centre line, m. */
const GEAR = 7.4;
const HINGE = new THREE.Vector3(0, -4.6, 5);
const RAMP_LEN = 9;
const FEET = [new THREE.Vector3(0, -GEAR, -12), new THREE.Vector3(6.5, -GEAR, 8), new THREE.Vector3(-6.5, -GEAR, 8)];

// ---------------------------------------------------------------------------
// Sparks, dust and fire: CPU particles in one draw call per blending mode.
// ---------------------------------------------------------------------------

class Particles {
    private geo = new THREE.BufferGeometry();
    private pos: Float32Array;
    private col: Float32Array;
    private size: Float32Array;
    private vel: Float32Array;
    private life: Float32Array;
    private max: Float32Array;
    private grav: Float32Array;
    private next = 0;
    readonly points: THREE.Points;

    constructor(scene: THREE.Scene, private n: number, additive: boolean, private g: number) {
        this.pos = new Float32Array(n * 3);
        this.col = new Float32Array(n * 4);
        this.size = new Float32Array(n);
        this.vel = new Float32Array(n * 3);
        this.life = new Float32Array(n);
        this.max = new Float32Array(n).fill(1);
        this.grav = new Float32Array(n);
        this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
        this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4));
        this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
        this.points = new THREE.Points(this.geo, new THREE.ShaderMaterial({
            vertexShader: /* glsl */ `
                #include <common>
                #include <logdepthbuf_pars_vertex>
                attribute vec4 aColor;
                attribute float aSize;
                varying vec4 vColor;
                void main() {
                    vColor = aColor;
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = aSize * 420.0 / max(-mv.z, 0.1);
                    gl_Position = projectionMatrix * mv;
                    #include <logdepthbuf_vertex>
                }`,
            fragmentShader: /* glsl */ `
                #include <logdepthbuf_pars_fragment>
                varying vec4 vColor;
                void main() {
                    #include <logdepthbuf_fragment>
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float a = smoothstep(1.0, 0.2, d) * vColor.a;
                    if (a < 0.01) discard;
                    gl_FragColor = vec4(vColor.rgb, a);
                }`,
            transparent: true, depthWrite: false,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        }));
        this.points.frustumCulled = false;
        scene.add(this.points);
    }

    emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, size: number, life: number, gravity = 1) {
        const i = this.next;
        this.next = (this.next + 1) % this.n;
        this.pos.set([p.x, p.y, p.z], i * 3);
        this.vel.set([v.x, v.y, v.z], i * 3);
        this.col.set([color.r, color.g, color.b, 1], i * 4);
        this.size[i] = size;
        this.life[i] = life;
        this.max[i] = life;
        this.grav[i] = gravity;
    }

    burst(p: THREE.Vector3, count: number, speed: number, color: THREE.Color, size: number, life: number, gravity = 1, up = 0) {
        const v = new THREE.Vector3();
        for (let k = 0; k < count; k++) {
            v.randomDirection().multiplyScalar(speed * (0.3 + Math.random() * 0.7));
            v.y = Math.abs(v.y) * up + v.y * (1 - up);
            this.emit(p, v, color, size * (0.6 + Math.random() * 0.8), life * (0.5 + Math.random() * 0.8), gravity);
        }
    }

    update(dt: number) {
        for (let i = 0; i < this.n; i++) {
            if (this.life[i] <= 0) { this.size[i] = 0; continue; }
            this.life[i] -= dt;
            const k = i * 3;
            this.vel[k + 1] -= this.g * this.grav[i] * dt;
            const drag = Math.exp(-1.5 * dt);
            this.vel[k] *= drag; this.vel[k + 1] *= drag; this.vel[k + 2] *= drag;
            this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
            this.col[i * 4 + 3] = Math.max(0, this.life[i] / this.max[i]);
        }
        this.geo.attributes.position.needsUpdate = true;
        this.geo.attributes.aColor.needsUpdate = true;
        this.geo.attributes.aSize.needsUpdate = true;
    }

    dispose() {
        this.points.removeFromParent();
        this.geo.dispose();
        (this.points.material as THREE.Material).dispose();
    }
}

// ---------------------------------------------------------------------------

interface Bolt { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; life: number; hostile: boolean; damage: number }

interface Foe {
    kind: GroundKind;
    def: FoeDef;
    rig: Rig;
    pos: THREE.Vector3;
    yaw: number;
    hp: number;
    cooldown: number;
    phase: number;
    seed: number;
    dying: number;
    bar: THREE.Sprite;
    barBg: THREE.Sprite;
    shadow: THREE.Mesh;
    hitAt: number;
}

interface Being {
    spec: BeingSpec;
    rig: Rig;
    pos: THREE.Vector3;
    yaw: number;
    home: THREE.Vector2;
    target: THREE.Vector2 | null;
    state: 'walk' | 'work' | 'greet' | 'chat';
    timer: number;
    phase: number;
    hailed: boolean;
    shadow: THREE.Mesh;
    /** What it is building, where, and how far along. */
    build: { s: Structure; at: THREE.Vector2; key: string; progress: number } | null;
    /** Walking over to (or talking with) another being. */
    chatWith: Being | null;
    /** On the way to the building site. */
    toSite: boolean;
}

interface Item { mesh: THREE.Group; pos: THREE.Vector3; mission: string; item: string }

type Mode = 'off' | 'exiting' | 'walk' | 'boarding' | 'dead';

function shadowTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class SurfaceGame {
    mode: Mode = 'off';
    /** Called once the robot is back aboard and the ramp is shut: time to take off. */
    onBoarded?: () => void;
    readonly robot: Robot;
    private robotPos = new THREE.Vector3();
    private robotVel = new THREE.Vector3();
    private robotYaw = 0;
    private grounded = true;
    private fuel = 1;
    private jets = false;
    private camYaw = 0;
    private camPitch = -0.12;
    private camDist = 5.5;
    private camBlend = 0;
    private fireCooldown = 0;
    private aimFor = 0;
    private rmb = false;
    private lmb = false;
    private sinceHit = 99;
    private deadFor = 0;
    private seq = 0;
    private exitPath: THREE.Vector3[] = [];
    private time = 0;
    private keys = new Set<string>();
    private jumpQueued = false;

    private ship: THREE.Group | null = null;
    private ramp = new THREE.Group();
    private rampLight: THREE.Mesh | null = null;
    private rampAngle = 0;
    private rampOpen = 0;
    private shipPos = new THREE.Vector3();
    private shipYaw = 0;

    private particles: Particles;
    private sparks: Particles;
    private bolts: Bolt[] = [];
    private foes: Foe[] = [];
    private beings: Being[] = [];
    private items: Item[] = [];
    private dialog = new DialogBox();
    private talkingTo: Being | null = null;
    private encounterIn = 35 + Math.random() * 20;
    private missionSpawnIn = 0;
    private shadowTex = shadowTexture();
    private shadowGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    private robotShadow: THREE.Mesh;
    private hud: { root: HTMLElement; prompt: HTMLElement; cross: HTMLElement; fuel: HTMLElement };
    private offLook: () => void;
    private rng = mulberry32(Date.now() & 0xffff);

    private onKeyDown = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        if (this.mode === 'off' || this.blocked) return;
        this.keys.add(e.code);
        if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.jumpQueued = true; }
        if (e.code === 'KeyE') this.interact();
        if (e.code === 'KeyF') this.board();
        if (e.code === 'KeyG') this.summon();
    };
    private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    private onDown = (e: PointerEvent) => {
        if (this.mode !== 'walk' || this.blocked) return;
        if (e.button === 2) this.rmb = true;
        if (e.button === 0) {
            if (document.pointerLockElement !== this.ctx.canvas && e.pointerType === 'mouse') this.ctx.canvas.requestPointerLock?.();
            else this.lmb = true;
        }
    };
    private onUp = (e: PointerEvent) => {
        if (e.button === 2) this.rmb = false;
        if (e.button === 0) this.lmb = false;
    };
    private lastTouch: { x: number; y: number } | null = null;
    private onMove = (e: PointerEvent) => {
        if (this.mode === 'off') return;
        let dx = 0, dy = 0;
        if (document.pointerLockElement === this.ctx.canvas) { dx = e.movementX; dy = e.movementY; }
        else if (e.buttons && e.target === this.ctx.canvas) {
            // Dragging (a touch screen, or a mouse without the pointer captured) turns the view too.
            if (this.lastTouch) { dx = e.clientX - this.lastTouch.x; dy = e.clientY - this.lastTouch.y; }
            this.lastTouch = { x: e.clientX, y: e.clientY };
        } else { this.lastTouch = null; return; }
        if (Math.abs(dx) > 150 || Math.abs(dy) > 150) return;
        this.camYaw -= dx * 0.0025;
        this.lookedAt = this.time;
        this.camPitch = Math.max(-1.2, Math.min(0.9, this.camPitch - dy * 0.0025));
    };
    private onWheel = (e: WheelEvent) => {
        if (this.mode !== 'walk') return;
        this.camDist = Math.max(2.5, Math.min(16, this.camDist * Math.exp(e.deltaY * 0.001)));
    };
    private onContext = (e: Event) => { if (this.mode !== 'off') e.preventDefault(); };

    constructor(private ctx: SurfaceContext) {
        this.robot = new Robot(progress.data.look);
        this.robot.root.visible = false;
        ctx.scene.add(this.robot.root);
        this.particles = new Particles(ctx.scene, 700, false, ctx.gravity);
        this.sparks = new Particles(ctx.scene, 900, true, ctx.gravity);
        this.robotShadow = this.makeShadow(0.7);
        this.robotShadow.visible = false;
        this.dialog.onQuest = (q, spec) => {
            const m = errandMission(q, spec);
            const here = q.type === 'collect' || (q.type === 'kill' && isGround(q.enemy!));
            if (here) this.ctx.game.log.addSide(m, this.time);
            else addErrandTo(this.ctx.systemKey, m, this.time);
            progress.memory(spec.id).errands.push({ title: m.title, state: 'active' });
            progress.save();
            this.ctx.toast(here
                ? `Поручение от ${spec.name}: «${m.title}» — здесь, на поверхности`
                : `Поручение от ${spec.name}: «${m.title}». Цель — ${m.location}: взлетайте, задание ждёт в космосе`);
        };
        this.dialog.onClose = () => { this.talkingTo = null; };

        const root = document.createElement('div');
        root.id = 'surfhud';
        root.hidden = true;
        root.innerHTML = `
            <div class="prompt"></div>
            <div class="cross"><i></i></div>
            <div class="fuel glass hud"><span>Ранец</span><i class="bar"><b></b></i></div>`;
        document.body.appendChild(root);
        this.hud = { root, prompt: root.querySelector('.prompt')!, cross: root.querySelector('.cross')!, fuel: root.querySelector('.fuel b')! };

        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        ctx.canvas.addEventListener('pointerdown', this.onDown);
        window.addEventListener('pointerup', this.onUp);
        window.addEventListener('pointermove', this.onMove);
        ctx.canvas.addEventListener('wheel', this.onWheel, { passive: true });
        ctx.canvas.addEventListener('contextmenu', this.onContext);
        // The robot and the parked ship wear the pilot's colours.
        this.offLook = progress.onChange(() => this.restyle());
    }

    /** A dialogue or the menu is open: the robot stands still. */
    private get blocked(): boolean {
        return this.dialog.open || !!document.querySelector('#gamemenu:not([hidden])');
    }

    private makeShadow(r: number): THREE.Mesh {
        const m = new THREE.Mesh(this.shadowGeo, new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false, opacity: 0.8 }));
        m.scale.setScalar(r);
        m.renderOrder = 1;
        this.ctx.scene.add(m);
        return m;
    }

    private placeShadow(s: THREE.Mesh, x: number, z: number, height: number) {
        const g = this.ctx.groundAt(x, z);
        s.position.set(x, Math.max(g, this.ctx.sea ?? -1e9) + 0.06, z);
        const k = Math.max(0, 1 - height / 12);
        (s.material as THREE.MeshBasicMaterial).opacity = 0.8 * k * this.sunShare;
    }

    /** How much the Sun lights the ground now, 0…1 (shadows fade at night). */
    sunShare = 1;

    // -----------------------------------------------------------------------
    // Landing, the ramp, getting out and back in.
    // -----------------------------------------------------------------------

    /** Height of the ship's centre when standing on its legs at (x, z) with this heading. */
    shipHeightAt(x: number, z: number, yaw: number): number {
        let top = -Infinity;
        for (const f of FEET) {
            const p = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            top = Math.max(top, this.ctx.groundAt(x + p.x, z + p.z), (this.ctx.sea ?? -1e9) + 0.2);
        }
        return top + GEAR;
    }

    /**
     * Somewhere to set down near (x, z): dry, not too steep under the legs. Returns the spot or null.
     */
    findPad(x: number, z: number, yaw: number): THREE.Vector3 | null {
        const sea = this.ctx.sea ?? -1e9;
        let best: THREE.Vector3 | null = null, bestScore = Infinity;
        for (let ring = 0; ring < 7; ring++) {
            const r = ring * ring * 25;
            const n = ring ? 10 + ring * 4 : 1;
            for (let k = 0; k < n; k++) {
                const a = (k / n) * Math.PI * 2;
                const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
                const hs = FEET.map(f => { const p = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw); return this.ctx.groundAt(px + p.x, pz + p.z); });
                const hc = this.ctx.groundAt(px, pz);
                if (Math.min(...hs, hc) < sea + 1) continue;
                const spread = Math.max(...hs, hc) - Math.min(...hs, hc);
                const score = spread * 3 + r * 0.02;
                if (spread < 4.5 && score < bestScore) { bestScore = score; best = new THREE.Vector3(px, 0, pz); }
            }
            if (best && ring >= 2) break;
        }
        if (best) best.y = this.shipHeightAt(best.x, best.z, yaw);
        return best;
    }

    /** The ship has touched down at `pos` (its centre) heading `yaw`: park it and let the robot out. */
    land(pos: THREE.Vector3, yaw: number, instant = false) {
        this.shipPos.copy(pos);
        this.shipYaw = yaw;
        this.buildShip();
        this.hud.root.hidden = false;
        this.robot.root.visible = true;
        this.robotShadow.visible = true;
        this.placeBeings();
        const hinge = this.shipPoint(HINGE);
        const end = this.rampEnd();
        const back = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const out = end.clone().addScaledVector(back, 4);
        out.y = this.ctx.groundAt(out.x, out.z);
        this.exitPath = [hinge.clone().addScaledVector(back, -1.5).setY(hinge.y + 0.05), hinge.clone().setY(hinge.y + 0.05), end, out];
        this.camYaw = yaw;
        this.robotYaw = yaw + Math.PI;
        if (instant) {
            this.rampOpen = 1;
            this.robotPos.copy(out);
            this.startWalking();
            return;
        }
        this.mode = 'exiting';
        this.seq = 0;
        this.rampOpen = 0;
        this.robotPos.copy(this.exitPath[0]);
        this.ctx.toast('Посадка. Открываем трап…');
    }

    private walkSince = 0;

    private startWalking() {
        this.mode = 'walk';
        this.walkSince = this.time;
        this.camBlend = 0;
        this.robotYaw = this.shipYaw + Math.PI;
        this.camYaw = this.shipYaw + Math.PI;
        this.camPitch = -0.15;
        this.ctx.toast('Робот на поверхности: WASD — идти, Shift — бег, Пробел — прыжок (держать — ранец), ЛКМ — огонь, E — говорить, F — в корабль. Клик — захватить мышь');
    }

    /** Walk back up the ramp. */
    board() {
        if (this.mode !== 'walk') return;
        if (this.driving) this.getOut();
        const end = this.rampEnd();
        if (this.robotPos.distanceTo(end) > BOARD_M * 1.6) { this.ctx.toast('Корабль далеко — подойдите к трапу'); return; }
        this.mode = 'boarding';
        this.seq = 0;
        this.exitPath = [this.robotPos.clone(), end, this.shipPoint(HINGE).setY(this.shipPoint(HINGE).y + 0.05), this.shipPoint(HINGE.clone().add(new THREE.Vector3(0, 0, -1.5)))];
        if (document.pointerLockElement) document.exitPointerLock();
        this.ctx.toast('Возвращаемся на борт…');
    }

    private interact() {
        if (this.mode !== 'walk') return;
        if (this.driving) { this.getOut(); return; }
        if (this.vehicle && this.carState === 'parked' && this.vehicle.pos.distanceTo(this.robotPos) < 4.5) { this.getIn(); return; }
        const b = this.nearestBeing();
        if (b) { this.talk(b); return; }
        if (this.robotPos.distanceTo(this.rampEnd()) < BOARD_M) this.board();
    }

    private talk(b: Being) {
        const mem = progress.memory(b.spec.id);
        const active = mem.errands[mem.errands.length - 1]?.state === 'active';
        this.talkingTo = b;
        this.keys.clear();
        this.dialog.start(b.spec, this.ctx.world, active ? 'active' : 'none', mem);
    }

    private nearestBeing(): Being | null {
        let best: Being | null = null, d = TALK_M;
        for (const b of this.beings) {
            const x = b.pos.distanceTo(this.robotPos);
            if (x < d) { d = x; best = b; }
        }
        return best;
    }

    private shipPoint(local: THREE.Vector3): THREE.Vector3 {
        return local.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.shipYaw).add(this.shipPos);
    }

    /** Where the lowered ramp meets the ground. */
    private rampEnd(): THREE.Vector3 {
        const a = this.rampAngle;
        return this.shipPoint(new THREE.Vector3(0, HINGE.y - RAMP_LEN * Math.sin(a), HINGE.z + RAMP_LEN * Math.cos(a)));
    }

    private buildShip() {
        if (this.ship) { this.ctx.scene.remove(this.ship); this.disposeTree(this.ship); }
        const g = makeShip(progress.data.look);
        // Engines off on the ground.
        g.traverse(o => { if (o.name === 'flame') o.visible = false; });
        const gear = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.85, roughness: 0.35 });
        const pad = new THREE.MeshStandardMaterial({ color: 0x22252b, metalness: 0.6, roughness: 0.6 });
        // Legs reach down to the ground under each foot, however uneven.
        for (const f of FEET) {
            const w = this.shipPoint(f);
            const ground = Math.max(this.ctx.groundAt(w.x, w.z), (this.ctx.sea ?? -1e9) + 0.2);
            const len = this.shipPos.y - 2.5 - ground;
            const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, len, 10), gear);
            strut.position.set(f.x, -2.5 - len / 2, f.z);
            g.add(strut);
            const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, len * 0.7, 8), gear);
            piston.position.set(f.x + (f.x ? -Math.sign(f.x) * 0.9 : 0), -2.5 - len * 0.35, f.z + (f.x ? 0 : 0.9));
            piston.rotation.z = f.x ? Math.sign(f.x) * 0.2 : 0;
            piston.rotation.x = f.x ? 0 : -0.2;
            g.add(piston);
            const foot = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.3, 16), pad);
            foot.position.set(f.x, -2.5 - len, f.z);
            g.add(foot);
        }
        // The ramp: a ribbed plate on a hinge under the hull, lit from inside.
        this.ramp = new THREE.Group();
        this.ramp.position.copy(HINGE);
        const plate = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, RAMP_LEN), new THREE.MeshStandardMaterial({ color: 0x565b64, metalness: 0.7, roughness: 0.5 }));
        plate.position.z = RAMP_LEN / 2;
        this.ramp.add(plate);
        for (let i = 1; i < 9; i++) {
            const rib = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.06, 0.12), gear);
            rib.position.set(0, 0.11, i);
            this.ramp.add(rib);
        }
        for (const s of [-1, 1]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, RAMP_LEN), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(progress.data.look.glow), emissiveIntensity: 1.5 }));
            rail.position.set(s * 1.25, 0.12, RAMP_LEN / 2);
            this.ramp.add(rail);
        }
        g.add(this.ramp);
        this.rampLight = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.92, 0.75).multiplyScalar(3), side: THREE.DoubleSide }));
        this.rampLight.position.set(0, -3.6, HINGE.z - 0.4);
        g.add(this.rampLight);
        g.position.copy(this.shipPos);
        g.rotation.y = this.shipYaw;
        this.ctx.scene.add(g);
        this.ship = g;
        // The angle at which the ramp's end rests on the ground.
        let a = 0.35;
        for (let k = 0; k < 4; k++) {
            this.rampAngle = a;
            const e = this.rampEnd();
            const drop = this.shipPoint(HINGE).y - (this.ctx.groundAt(e.x, e.z) + 0.1);
            a = Math.asin(Math.max(0.05, Math.min(0.95, drop / RAMP_LEN)));
        }
        this.rampAngle = a;
    }

    /** The parked ship goes (taking off): the flying one takes over. */
    unpark(): { pos: THREE.Vector3; yaw: number } {
        const out = { pos: this.shipPos.clone(), yaw: this.shipYaw };
        if (this.ship) { this.ctx.scene.remove(this.ship); this.disposeTree(this.ship); this.ship = null; }
        this.mode = 'off';
        this.robot.root.visible = false;
        this.robotShadow.visible = false;
        this.hud.root.hidden = true;
        this.stowCar();
        this.clearLife();
        return out;
    }

    private restyle() {
        if (this.ship) this.buildShip();
        const vis = this.robot.root.visible;
        this.ctx.scene.remove(this.robot.root);
        this.robot.dispose();
        (this as { robot: Robot }).robot = new Robot(progress.data.look);
        this.robot.root.visible = vis;
        this.ctx.scene.add(this.robot.root);
    }

    // -----------------------------------------------------------------------
    // The frame.
    // -----------------------------------------------------------------------

    get active(): boolean { return this.mode !== 'off'; }

    /** Dust blown about by the ship's thrusters as it lands or takes off. */
    dust(at: THREE.Vector3, n: number, spread: number) {
        const p = new THREE.Vector3(), v = new THREE.Vector3();
        for (let k = 0; k < n; k++) {
            const a = Math.random() * Math.PI * 2, r = Math.random() * spread * 0.4;
            p.set(at.x + Math.cos(a) * r, this.ctx.groundAt(at.x + Math.cos(a) * r, at.z + Math.sin(a) * r) + 0.3, at.z + Math.sin(a) * r);
            v.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(spread * (0.5 + Math.random() * 0.6)).setY(1 + Math.random() * 3);
            this.particles.emit(p, v, this.ctx.dustColor, 2 + Math.random() * 2.5, 2 + Math.random() * 1.5, 0.05);
        }
    }

    update(dt: number, camera: THREE.PerspectiveCamera) {
        dt = Math.min(dt, 0.05);
        if (this.mode === 'off') {
            this.particles.update(dt);
            this.sparks.update(dt);
            return;
        }
        this.time += dt;
        // Ramp.
        const wantOpen = this.mode === 'exiting' || this.mode === 'walk' || this.mode === 'dead' || (this.mode === 'boarding' && this.seq < 2.6) ? 1 : 0;
        this.rampOpen += Math.sign(wantOpen - this.rampOpen) * Math.min(Math.abs(wantOpen - this.rampOpen), dt / 1.4);
        this.ramp.rotation.x = this.rampAngle * THREE.MathUtils.smoothstep(this.rampOpen, 0, 1);
        if (this.rampLight) this.rampLight.visible = this.rampOpen > 0.05;

        if (this.mode === 'exiting' || this.mode === 'boarding') this.scripted(dt, camera);
        else if (this.mode === 'walk') { if (this.driving) this.drive(dt, camera); else this.walk(dt, camera); }
        if (this.vehicle && !this.driving) this.carIdle(dt);
        else if (this.mode === 'dead') this.dead(dt, camera);

        this.updateBeings(dt);
        this.updateFoes(dt);
        this.updateBolts(dt);
        this.updateItems(dt);
        this.particles.update(dt);
        this.sparks.update(dt);
        this.robot.root.position.copy(this.robotPos);
        if (this.driving && this.vehicle) this.robot.root.quaternion.copy(this.vehicle.bodyQuaternion);
        else this.robot.root.rotation.set(0, this.robotYaw, 0);
        this.placeShadow(this.robotShadow, this.robotPos.x, this.robotPos.z, this.robotPos.y - this.ctx.groundAt(this.robotPos.x, this.robotPos.z));
        this.robotShadow.visible = this.robot.root.visible;
        // The head lamp comes on as the light goes.
        this.robot.headlamp.intensity = (1 - this.sunShare) * 40;
        this.renderHud();
    }

    /** Walking out of the ship or back into it along the path; the camera watches from the side. */
    private scripted(dt: number, camera: THREE.PerspectiveCamera) {
        this.seq += dt;
        const waitRamp = this.mode === 'exiting' ? 1.5 : 0;
        const speed = 2.3;
        let t = Math.max(0, this.seq - waitRamp) * speed;
        let i = 0;
        const path = this.exitPath;
        while (i < path.length - 1 && t > path[i].distanceTo(path[i + 1])) { t -= path[i].distanceTo(path[i + 1]); i++; }
        const done = i >= path.length - 1;
        const a = path[Math.min(i, path.length - 1)], b = path[Math.min(i + 1, path.length - 1)];
        const seg = a.distanceTo(b);
        const p = done ? b.clone() : a.clone().lerp(b, seg > 0 ? t / seg : 1);
        const moving = !done && this.seq > waitRamp;
        if (moving) {
            const dir = new THREE.Vector3().subVectors(b, a);
            if (dir.lengthSq() > 1e-4) this.robotYaw = Math.atan2(-dir.x, -dir.z);
        }
        // On flat ground stay on the ground (the path's own heights are only for the ramp).
        if (i >= 2 && this.mode === 'exiting') p.y = this.ctx.groundAt(p.x, p.z);
        if (this.mode === 'boarding' && i === 0) p.y = this.ctx.groundAt(p.x, p.z);
        this.robotPos.copy(p);
        this.robot.update(dt, { speed: moving ? speed : 0, grounded: true, jets: false, aiming: false, aimPitch: 0, gravity: this.ctx.gravity });
        // The camera: off to the side of the ramp, watching the robot come down.
        const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.shipYaw);
        const back = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.shipYaw);
        const end = this.rampEnd();
        const eye = end.clone().addScaledVector(side, 9).addScaledVector(back, 9);
        eye.y = Math.max(this.ctx.groundAt(eye.x, eye.z) + 2.5, end.y + 3);
        camera.position.lerp(eye, 1 - Math.exp(-3 * dt));
        camera.lookAt(this.robotPos.x, this.robotPos.y + 1.3, this.robotPos.z);
        if (this.mode === 'boarding' && done) this.robot.root.visible = false;
        if (this.mode === 'exiting' && done) this.startWalking();
        if (this.mode === 'boarding' && done && this.rampOpen <= 0.001) {
            this.mode = 'off';
            this.onBoarded?.();
        }
    }

    private walk(dt: number, camera: THREE.PerspectiveCamera) {
        const g = Math.max(this.ctx.gravity, 0.5);
        const held = (c: string) => this.keys.has(c) || virtualKeys.has(c);
        const blocked = this.blocked;
        const fwd = blocked ? 0 : (held('KeyW') || held('ArrowUp') ? 1 : 0) - (held('KeyS') || held('ArrowDown') ? 1 : 0);
        const strafe = blocked ? 0 : (held('KeyD') || held('ArrowRight') ? 1 : 0) - (held('KeyA') || held('ArrowLeft') ? 1 : 0);
        const sprint = held('ShiftLeft') || held('ShiftRight');
        const forward = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
        const right = new THREE.Vector3(-forward.z, 0, forward.x);
        const wish = forward.multiplyScalar(fwd).addScaledVector(right, strafe);
        if (wish.lengthSq() > 1) wish.normalize();
        // Wading slows the robot down.
        const ground = this.ctx.groundAt(this.robotPos.x, this.robotPos.z);
        const wading = this.ctx.sea !== null && ground < this.ctx.sea;
        const speed = (sprint ? RUN : WALK) * (wading ? 0.5 : 1);
        const accel = this.grounded ? 22 : 4;
        const hv = new THREE.Vector3(this.robotVel.x, 0, this.robotVel.z);
        const dv = wish.clone().multiplyScalar(speed).sub(hv);
        const maxDv = accel * dt;
        if (dv.length() > maxDv) dv.setLength(maxDv);
        if (this.grounded || wish.lengthSq() > 0) { this.robotVel.x += dv.x; this.robotVel.z += dv.z; }
        // Jump, and the jet pack while Space is held in the air.
        if (this.jumpQueued && this.grounded) {
            this.robotVel.y = Math.min(5.5, Math.sqrt(2 * g * 7));
            this.grounded = false;
            this.particles.burst(this.robotPos, 10, 1.5, this.ctx.dustColor, 0.35, 1.2, 0.2, 1);
        }
        this.jumpQueued = false;
        const space = !blocked && (held('Space'));
        this.jets = space && !this.grounded && this.fuel > 0 && this.robotVel.y < 7;
        if (this.jets) {
            this.robotVel.y += (g + 6) * dt;
            this.fuel = Math.max(0, this.fuel - dt / 2.6);
            const nozzle = this.robotPos.clone().add(new THREE.Vector3(0, 1.0, 0.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.robotYaw));
            const fire = new THREE.Color(progress.data.look.glow).multiplyScalar(2);
            for (let k = 0; k < 3; k++) this.sparks.emit(nozzle, new THREE.Vector3((Math.random() - 0.5) * 1.5, -6 - Math.random() * 4, (Math.random() - 0.5) * 1.5), fire, 0.3, 0.35, 0.1);
        } else if (this.grounded) this.fuel = Math.min(1, this.fuel + dt * 0.4);
        if (!this.grounded) this.robotVel.y -= g * dt;
        // Move, round trunks and boulders, not into deep water, not up cliffs.
        const next = this.robotPos.clone().addScaledVector(this.robotVel, dt);
        const nextGround = this.ctx.groundAt(next.x, next.z);
        if (this.ctx.sea !== null && nextGround < this.ctx.sea - 1.2) { next.x = this.robotPos.x; next.z = this.robotPos.z; this.robotVel.x = this.robotVel.z = 0; }
        const climb = (nextGround - ground) / Math.max(Math.hypot(next.x - this.robotPos.x, next.z - this.robotPos.z), 1e-3);
        if (this.grounded && climb > 1.2) { next.x = this.robotPos.x; next.z = this.robotPos.z; }
        this.pushOut(next);
        const floor = this.ctx.groundAt(next.x, next.z);
        if (next.y <= floor + 0.02 || (this.grounded && next.y - floor < 0.6 && this.robotVel.y <= 0)) {
            if (!this.grounded && this.robotVel.y < -6) this.particles.burst(next.clone().setY(floor), 14, 2, this.ctx.dustColor, 0.45, 1.4, 0.2, 1);
            next.y = floor;
            if (this.robotVel.y < 0) this.robotVel.y = 0;
            this.grounded = true;
        } else this.grounded = false;
        this.robotPos.copy(next);
        if (this.grounded) {
            // Friction when no key is held.
            if (wish.lengthSq() === 0) { this.robotVel.x *= Math.exp(-10 * dt); this.robotVel.z *= Math.exp(-10 * dt); }
            // Kick up dust when running on dusty ground.
            const hs = Math.hypot(this.robotVel.x, this.robotVel.z);
            if (hs > 6 && Math.random() < dt * 8 && !wading) this.particles.emit(this.robotPos.clone().setY(this.robotPos.y + 0.1), new THREE.Vector3(-this.robotVel.x * 0.1, 0.6, -this.robotVel.z * 0.1), this.ctx.dustColor, 0.5, 1.5, 0.1);
            if (wading && hs > 1 && Math.random() < dt * 12) this.sparks.emit(this.robotPos.clone().setY((this.ctx.sea ?? 0) + 0.1), new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2), new THREE.Color(0.6, 0.7, 0.8), 0.18, 0.6, 1);
        }

        // Facing: along the motion, or at the crosshair while aiming or shooting.
        const hs = Math.hypot(this.robotVel.x, this.robotVel.z);
        const locked = document.pointerLockElement === this.ctx.canvas;
        const firing = !blocked && (this.lmb && locked);
        if (firing || this.rmb) this.aimFor = 1.2;
        this.aimFor = Math.max(0, this.aimFor - dt);
        const aiming = this.aimFor > 0;
        const want = aiming ? this.camYaw : hs > 0.5 ? Math.atan2(-this.robotVel.x, -this.robotVel.z) : this.robotYaw;
        this.robotYaw += wrap(want - this.robotYaw) * (1 - Math.exp(-(aiming ? 18 : 9) * dt));
        this.robot.update(dt, { speed: this.grounded ? hs : 0, grounded: this.grounded, jets: this.jets, aiming, aimPitch: this.camPitch + 0.12, gravity: g, yaw: this.robotYaw });

        // Camera: over the right shoulder, pulled in closer while aiming, never under the ground.
        this.camBlend = Math.min(1, this.camBlend + dt * 1.5);
        const dist = this.camDist * (this.rmb ? 0.55 : 1);
        const dir = new THREE.Vector3(-Math.sin(this.camYaw) * Math.cos(this.camPitch), Math.sin(this.camPitch), -Math.cos(this.camYaw) * Math.cos(this.camPitch));
        const shoulder = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw)).multiplyScalar(0.6);
        const target = this.robotPos.clone().add(new THREE.Vector3(0, 1.7, 0)).add(shoulder);
        const eye = target.clone().addScaledVector(dir, -dist);
        const floorEye = this.ctx.groundAt(eye.x, eye.z) + 0.5;
        if (eye.y < floorEye) eye.y = floorEye;
        if (this.camBlend < 1) {
            camera.position.lerp(eye, THREE.MathUtils.smoothstep(this.camBlend, 0, 1));
        } else camera.position.copy(eye);
        camera.lookAt(target.clone().addScaledVector(dir, 20));

        // Shooting.
        this.fireCooldown -= dt;
        if (firing && this.fireCooldown <= 0) {
            this.fireCooldown = 0.16 * (effects.fireInterval / 0.12);
            this.shoot(camera);
        }
        // The shield comes back after a quiet spell.
        this.sinceHit += dt;
        if (this.sinceHit > 3) pilotState.shield = Math.min(pilotState.maxShield, pilotState.shield + effects.regen * dt);

        this.spawning(dt);
        this.hails();
        this.chats(dt);
        this.overhear(dt);
    }

    private pushOut(p: THREE.Vector3) {
        const push = (cx: number, cz: number, r: number) => {
            const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz), min = r + 0.45;
            if (d < min && d > 1e-4) { p.x = cx + (dx / d) * min; p.z = cz + (dz / d) * min; }
        };
        const o = this.ctx.obstacle(p.x, p.z);
        if (o && p.y < this.ctx.groundAt(o.x, o.z) + o.r * 2.2) push(o.x, o.z, o.r);
        if (this.ship) for (const f of FEET) { const w = this.shipPoint(f); push(w.x, w.z, 1.2); }
        for (const b of this.beings) push(b.pos.x, b.pos.z, b.rig.radius * 0.8);
        for (const f of this.foes) if (f.dying < 0 && f.def.hover === 0) push(f.pos.x, f.pos.z, f.rig.radius * 0.8);
    }

    private dead(dt: number, camera: THREE.PerspectiveCamera) {
        this.deadFor += dt;
        this.robot.collapsed = Math.min(1, this.deadFor / 1.2);
        this.robot.update(dt, { speed: 0, grounded: true, jets: false, aiming: false, aimPitch: 0, gravity: this.ctx.gravity });
        const target = this.robotPos.clone().add(new THREE.Vector3(0, 1, 0));
        const eye = target.clone().add(new THREE.Vector3(Math.sin(this.time * 0.3) * 7, 4, Math.cos(this.time * 0.3) * 7));
        eye.y = Math.max(eye.y, this.ctx.groundAt(eye.x, eye.z) + 1);
        camera.position.lerp(eye, 1 - Math.exp(-2 * dt));
        camera.lookAt(target);
        if (this.deadFor > 3.5) {
            // Rebuilt by the ship's repair bay, and set down at the foot of the ramp.
            this.robot.collapsed = 0;
            pilotState.hull = pilotState.maxHull;
            pilotState.shield = pilotState.maxShield;
            pilotState.score = Math.max(0, pilotState.score - 100);
            const end = this.rampEnd();
            this.robotPos.copy(end).setY(this.ctx.groundAt(end.x, end.z));
            this.robotVel.set(0, 0, 0);
            for (const f of this.foes) if (f.pos.distanceTo(this.robotPos) < 60) f.dying = Math.max(f.dying, 0.5);
            this.startWalking();
            this.ctx.toast('Робот восстановлен ремонтным отсеком корабля (−100 очков)');
        }
    }

    // -----------------------------------------------------------------------
    // The rover.
    // -----------------------------------------------------------------------

    private vehicle: Vehicle | null = null;
    private carState: 'coming' | 'parked' | 'driving' = 'parked';
    private carWay: THREE.Vector3[] = [];
    private driving = false;
    private lookedAt = -9;

    /** Call the rover out of the hold: it drives down the ramp and over to the robot. */
    summon() {
        if (this.mode !== 'walk' || this.driving) return;
        if (!this.vehicle) {
            this.vehicle = new Vehicle(progress.data.look);
            this.ctx.scene.add(this.vehicle.root);
        }
        const v = this.vehicle;
        const back = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.shipYaw);
        if (this.carState !== 'parked' || v.pos.distanceTo(this.robotPos) > 250 || v.pos.lengthSq() === 0) {
            // Out of the hold: from inside, down the ramp.
            const inside = this.shipPoint(HINGE.clone().add(new THREE.Vector3(0, 0, -3)));
            v.place(inside.setY(inside.y + 0.5), this.shipYaw + Math.PI);
        }
        const foot = this.rampEnd().addScaledVector(back, 6);
        this.carWay = v.pos.distanceTo(this.shipPos) < 20 ? [foot, this.robotPos.clone()] : [this.robotPos.clone()];
        this.carState = 'coming';
        this.ctx.toast('🚙 Вездеход выезжает из трюма…');
    }

    /** The ground the rover rolls on: the terrain, or the ramp and the hold floor under the ship. */
    private carGround = (x: number, z: number): number => {
        const g = this.ctx.groundAt(x, z);
        if (!this.ship) return g;
        const local = new THREE.Vector3(x - this.shipPos.x, 0, z - this.shipPos.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.shipYaw);
        if (Math.abs(local.x) > 1.4) return g;
        const a = this.rampAngle * THREE.MathUtils.smoothstep(this.rampOpen, 0, 1);
        const floor = this.shipPos.y + HINGE.y;
        if (local.z < HINGE.z && local.z > HINGE.z - 5) return Math.max(g, floor);
        const along = local.z - HINGE.z;
        if (along >= 0 && along <= RAMP_LEN * Math.cos(a)) return Math.max(g, floor - along * Math.tan(a));
        return g;
    };

    private carBlocked = (x: number, z: number): boolean => {
        if (this.ctx.sea !== null && this.ctx.groundAt(x, z) < this.ctx.sea - 0.8) return true;
        if (this.ship) for (const f of FEET) { const w = this.shipPoint(f); if (Math.hypot(w.x - x, w.z - z) < 1.6) return true; }
        const o = this.ctx.obstacle(x, z);
        return !!o && Math.hypot(o.x - x, o.z - z) < o.r + 0.3;
    };

    /** Coming over, or parked and waiting. */
    private carIdle(dt: number) {
        const v = this.vehicle!;
        const g = Math.max(this.ctx.gravity, 0.5);
        if (this.carState === 'coming') {
            const to = this.carWay[0] ?? this.robotPos;
            if (this.carWay.length <= 1) this.carWay[0] = this.robotPos.clone();
            if (v.autoDrive(dt, to, this.carGround, this.carBlocked, g)) {
                this.carWay.shift();
                if (!this.carWay.length) { this.carState = 'parked'; this.ctx.toast('🚙 Вездеход подъехал. E — сесть'); }
            }
        } else {
            v.update(dt, { throttle: 0, steer: 0, brake: true, boost: false }, this.carGround, this.carBlocked, g);
        }
        v.lampOn = (1 - this.sunShare) * 60;
    }

    private getIn() {
        const v = this.vehicle!;
        this.driving = true;
        this.carState = 'driving';
        this.camYaw = v.yaw;
        this.ctx.toast('За рулём: W/S — газ и задний ход, A/D — руль, Пробел — тормоз, Shift — ускорение, E — выйти');
    }

    private getOut() {
        const v = this.vehicle!;
        this.driving = false;
        this.carState = 'parked';
        const left = new THREE.Vector3(-Math.cos(v.yaw), 0, Math.sin(v.yaw));
        const p = v.pos.clone().addScaledVector(left, 2.2);
        this.robotPos.set(p.x, this.ctx.groundAt(p.x, p.z), p.z);
        this.robotVel.set(0, 0, 0);
        this.robotYaw = v.yaw;
    }

    private stowCar() {
        if (!this.vehicle) return;
        this.driving = false;
        this.ctx.scene.remove(this.vehicle.root);
        this.vehicle.dispose();
        this.vehicle = null;
        this.carState = 'parked';
    }

    private drive(dt: number, camera: THREE.PerspectiveCamera) {
        const v = this.vehicle!;
        const held = (c: string) => this.keys.has(c) || virtualKeys.has(c);
        const blocked = this.blocked;
        const throttle = blocked ? 0 : (held('KeyW') || held('ArrowUp') ? 1 : 0) - (held('KeyS') || held('ArrowDown') ? 1 : 0);
        const steer = blocked ? 0 : (held('KeyD') || held('ArrowRight') ? 1 : 0) - (held('KeyA') || held('ArrowLeft') ? 1 : 0);
        this.jumpQueued = false;
        v.update(dt, { throttle, steer, brake: held('Space'), boost: held('ShiftLeft') || held('ShiftRight') }, this.carGround, this.carBlocked, Math.max(this.ctx.gravity, 0.5));
        v.lampOn = (1 - this.sunShare) * 60;
        this.robotPos.copy(v.seatWorld());
        this.robotYaw = v.yaw;
        this.robot.update(dt, { speed: 0, grounded: true, jets: false, aiming: false, aimPitch: 0, gravity: this.ctx.gravity, seated: true, steer });
        if (Math.abs(v.speed) > 6 && Math.random() < dt * 20) {
            const back = v.pos.clone().addScaledVector(v.forward, -1.6);
            this.particles.emit(back.setY(this.ctx.groundAt(back.x, back.z) + 0.2), v.forward.multiplyScalar(-v.speed * 0.1).setY(1 + Math.random()), this.ctx.dustColor, 0.8 + Math.random() * 0.6, 1.4, 0.1);
        }
        // Chase camera: swings behind the car unless the pilot has just looked round with the mouse.
        if (this.time - this.lookedAt > 1.5) this.camYaw += wrap(v.yaw - this.camYaw) * (1 - Math.exp(-2.5 * dt));
        const dir = new THREE.Vector3(-Math.sin(this.camYaw) * Math.cos(this.camPitch), Math.sin(this.camPitch), -Math.cos(this.camYaw) * Math.cos(this.camPitch));
        const target = v.pos.clone().add(new THREE.Vector3(0, 1.4, 0));
        const eye = target.clone().addScaledVector(dir, -Math.max(this.camDist, 5) * 1.5).add(new THREE.Vector3(0, 1.2, 0));
        eye.y = Math.max(eye.y, this.ctx.groundAt(eye.x, eye.z) + 0.8);
        camera.position.lerp(eye, 1 - Math.exp(-10 * dt));
        camera.lookAt(target.addScaledVector(dir, 8));
        this.sinceHit += dt;
        if (this.sinceHit > 3) pilotState.shield = Math.min(pilotState.maxShield, pilotState.shield + effects.regen * dt);
        this.spawning(dt);
        this.hails();
        this.chats(dt);
        this.overhear(dt);
    }

    // -----------------------------------------------------------------------
    // Shooting and getting shot.
    // -----------------------------------------------------------------------

    private boltMats = new Map<number, THREE.MeshBasicMaterial>();
    private boltGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);

    private fireBolt(from: THREE.Vector3, dir: THREE.Vector3, speed: number, color: number, hostile: boolean, damage: number) {
        let mat = this.boltMats.get(color);
        if (!mat) {
            mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(8), toneMapped: false });
            this.boltMats.set(color, mat);
        }
        const mesh = new THREE.Mesh(this.boltGeo, mat);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        mesh.position.copy(from);
        this.ctx.scene.add(mesh);
        this.bolts.push({ mesh, pos: from.clone(), vel: dir.clone().multiplyScalar(speed), life: 2.5, hostile, damage });
    }

    private shoot(camera: THREE.PerspectiveCamera) {
        this.robot.root.updateMatrixWorld(true);
        const muzzle = new THREE.Vector3().setFromMatrixPosition(this.robot.muzzle.matrixWorld);
        // Aim where the crosshair (the screen centre) points: the first enemy on that line, else the ground.
        const ro = camera.position.clone();
        const rd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        let aim = ro.clone().addScaledVector(rd, 300);
        let best = 300;
        for (const f of this.foes) {
            if (f.dying >= 0) continue;
            const c = this.foeCentre(f);
            const t = c.clone().sub(ro).dot(rd);
            if (t > 0 && t < best && c.distanceTo(ro.clone().addScaledVector(rd, t)) < f.rig.radius) { best = t; aim = ro.clone().addScaledVector(rd, t); }
        }
        if (best === 300) {
            for (let t = 2; t < 300; t += t * 0.08 + 0.5) {
                const p = ro.clone().addScaledVector(rd, t);
                if (p.y < this.ctx.groundAt(p.x, p.z)) { aim = p; break; }
            }
        }
        const dir = aim.sub(muzzle).normalize();
        this.fireBolt(muzzle, dir, 140, new THREE.Color(progress.data.look.glow).getHex(), false, 20 * effects.damage);
        this.sparks.burst(muzzle, 5, 3, new THREE.Color(progress.data.look.glow).multiplyScalar(2), 0.15, 0.12, 0);
    }

    private foeCentre(f: Foe): THREE.Vector3 {
        return f.pos.clone().setY(f.pos.y + (f.def.hover > 0 ? 0 : f.rig.chest));
    }

    private hurtRobot(amount: number) {
        if (this.mode !== 'walk') return;
        this.sinceHit = 0;
        const absorbed = Math.min(pilotState.shield, amount);
        pilotState.shield -= absorbed;
        pilotState.hull = Math.max(0, pilotState.hull - (amount - absorbed));
        this.robot.flinch();
        this.ctx.game.flashHit();
        if (pilotState.hull <= 0) {
            if (this.driving) this.getOut();
            this.mode = 'dead';
            this.deadFor = 0;
            if (document.pointerLockElement) document.exitPointerLock();
            this.sparks.burst(this.robotPos.clone().setY(this.robotPos.y + 1.2), 60, 7, new THREE.Color(3, 1.2, 0.3), 0.3, 0.9, 0.6);
            this.ctx.toast('Робот разрушен!');
        }
    }

    private updateBolts(dt: number) {
        for (let i = this.bolts.length - 1; i >= 0; i--) {
            const b = this.bolts[i];
            const from = b.pos.clone();
            b.pos.addScaledVector(b.vel, dt);
            b.life -= dt;
            b.mesh.position.copy(b.pos);
            let hit = false;
            if (b.hostile) {
                if (this.mode === 'walk' && segmentHits(from, b.pos, this.robotPos.clone().setY(this.robotPos.y + 1.1), 0.75)) {
                    this.hurtRobot(b.damage);
                    this.sparks.burst(b.pos, 12, 4, new THREE.Color(3, 1, 0.4), 0.18, 0.3, 0.5);
                    hit = true;
                }
            } else {
                for (const f of this.foes) {
                    if (f.dying >= 0) continue;
                    if (segmentHits(from, b.pos, this.foeCentre(f), f.rig.radius)) {
                        this.damageFoe(f, b.damage);
                        this.sparks.burst(b.pos, 10, 4, new THREE.Color(2.5, 2, 1), 0.16, 0.3, 0.5);
                        hit = true;
                        break;
                    }
                }
            }
            if (!hit && b.pos.y < this.ctx.groundAt(b.pos.x, b.pos.z)) {
                this.sparks.burst(b.pos.clone().setY(this.ctx.groundAt(b.pos.x, b.pos.z) + 0.1), 8, 3, new THREE.Color(2, 1.4, 0.8), 0.14, 0.35, 0.8, 1);
                this.particles.burst(b.pos.clone().setY(this.ctx.groundAt(b.pos.x, b.pos.z) + 0.1), 4, 1.2, this.ctx.dustColor, 0.4, 1, 0.2, 1);
                hit = true;
            }
            if (hit || b.life <= 0) {
                this.ctx.scene.remove(b.mesh);
                this.bolts.splice(i, 1);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Enemies.
    // -----------------------------------------------------------------------

    private spawnFoes(kind: GroundKind, count: number) {
        for (let k = 0; k < count; k++) {
            let pos: THREE.Vector3 | null = null;
            for (let tries = 0; tries < 12 && !pos; tries++) {
                const a = this.rng() * Math.PI * 2, r = 55 + this.rng() * 40;
                const x = this.robotPos.x + Math.cos(a) * r, z = this.robotPos.z + Math.sin(a) * r;
                const g = this.ctx.groundAt(x, z);
                if (this.ctx.sea !== null && g < this.ctx.sea + 0.5) continue;
                pos = new THREE.Vector3(x, g, z);
            }
            if (!pos) continue;
            const def = FOES[kind];
            const rig = makeFoe(kind);
            this.ctx.scene.add(rig.root);
            const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xff3a30, depthWrite: false }));
            const barBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x101010, opacity: 0.6, transparent: true, depthWrite: false }));
            bar.center.set(0, 0.5);
            barBg.center.set(0, 0.5);
            bar.visible = barBg.visible = false;
            this.ctx.scene.add(bar, barBg);
            const f: Foe = {
                kind, def, rig, pos, yaw: 0, hp: def.hp, cooldown: 1 + this.rng() * 1.5, phase: this.rng() * 10, seed: this.rng() * 100,
                dying: -1, bar, barBg, shadow: this.makeShadow(rig.radius * 1.1), hitAt: -9,
            };
            if (def.hover) f.pos.y += def.hover;
            this.foes.push(f);
        }
    }

    private damageFoe(f: Foe, amount: number) {
        f.hp -= amount;
        f.hitAt = this.time;
        if (f.hp <= 0 && f.dying < 0) {
            f.dying = 0;
            const c = this.foeCentre(f);
            this.sparks.burst(c, 70, 9, new THREE.Color(3, 1.3, 0.4), 0.35, 0.9, 0.5);
            this.sparks.burst(c, 30, 4, new THREE.Color(f.def.boltColor).multiplyScalar(3), 0.5, 0.6, 0.2);
            this.particles.burst(c, 25, 3, new THREE.Color(0.08, 0.07, 0.06), 1.2, 2.2, -0.05);
            this.ctx.game.log.kill(f.kind);
            pilotState.score += f.def.score;
            progress.data.stats.kills++;
        }
    }

    private updateFoes(dt: number) {
        const r = this.robotPos;
        const alive = this.mode === 'walk';
        for (let i = this.foes.length - 1; i >= 0; i--) {
            const f = this.foes[i];
            const d = f.def;
            if (f.dying >= 0) {
                f.dying += dt;
                f.rig.root.scale.setScalar(Math.max(0.01, 1 - f.dying * 1.6));
                f.rig.root.position.y -= dt * 0.5;
                if (f.dying > 0.6) {
                    this.ctx.scene.remove(f.rig.root, f.bar, f.barBg, f.shadow);
                    this.disposeTree(f.rig.root);
                    this.foes.splice(i, 1);
                }
                continue;
            }
            const to = new THREE.Vector3(r.x - f.pos.x, 0, r.z - f.pos.z);
            const dist = to.length();
            to.normalize();
            const v = new THREE.Vector3();
            if (alive && dist < 260) {
                if (d.attack === 'melee') {
                    const charge = f.kind === 'brute' && dist < 16 ? 1.9 : 1;
                    if (dist > d.reach * 0.8) v.copy(to).multiplyScalar(d.speed * charge);
                } else {
                    const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(Math.sign(Math.sin(this.time * 0.4 + f.seed)) * 0.6);
                    if (dist > d.range * 0.85) v.copy(to);
                    else if (dist < d.range * 0.4) v.copy(to).negate();
                    v.add(side).normalize().multiplyScalar(d.speed);
                }
            }
            // Keep apart from each other.
            for (const o of this.foes) {
                if (o === f || o.dying >= 0) continue;
                const dx = f.pos.x - o.pos.x, dz = f.pos.z - o.pos.z, dd = Math.hypot(dx, dz), min = f.rig.radius + o.rig.radius;
                if (dd < min && dd > 1e-3) { v.x += (dx / dd) * 3; v.z += (dz / dd) * 3; }
            }
            const nx = f.pos.x + v.x * dt, nz = f.pos.z + v.z * dt;
            const g = this.ctx.groundAt(nx, nz);
            if (d.hover || this.ctx.sea === null || g > this.ctx.sea - 0.5) { f.pos.x = nx; f.pos.z = nz; }
            const floor = Math.max(this.ctx.groundAt(f.pos.x, f.pos.z), d.hover ? (this.ctx.sea ?? -1e9) : -1e9);
            f.pos.y = d.hover ? floor + d.hover + Math.sin(this.time * 2 + f.seed) * 0.5 : floor;
            const faceYaw = Math.atan2(-to.x, -to.z);
            f.yaw += wrap(faceYaw - f.yaw) * (1 - Math.exp(-6 * dt));
            // Attack.
            f.cooldown -= dt;
            if (alive && f.cooldown <= 0) {
                if (d.attack === 'melee' && dist < d.reach + 0.4) {
                    f.cooldown = d.cooldown;
                    this.hurtRobot(d.damage);
                    if (f.kind === 'brute') { this.robotVel.addScaledVector(to, 9).setY(4); this.grounded = false; }
                    this.sparks.burst(r.clone().setY(r.y + 1), 10, 3, new THREE.Color(3, 0.8, 0.3), 0.2, 0.3, 0.5);
                } else if (d.attack === 'ranged' && dist < d.range) {
                    f.cooldown = d.cooldown * (0.8 + this.rng() * 0.4);
                    const from = this.foeCentre(f).addScaledVector(to, f.rig.radius * 0.8);
                    const aimAt = r.clone().setY(r.y + 1.2).addScaledVector(this.robotVel, dist / 42 * 0.6);
                    aimAt.x += (this.rng() - 0.5) * 1.6; aimAt.z += (this.rng() - 0.5) * 1.6; aimAt.y += (this.rng() - 0.5) * 0.8;
                    this.fireBolt(from, aimAt.sub(from).normalize(), 42, d.boltColor, true, d.damage);
                }
            }
            // Pose.
            const moving = v.lengthSq() > 0.1;
            f.phase += dt * (moving ? d.speed * 2.2 : 0.8);
            this.animateFoe(f, moving);
            f.rig.root.position.copy(f.pos);
            f.rig.root.rotation.y = f.yaw;
            this.placeShadow(f.shadow, f.pos.x, f.pos.z, d.hover ? d.hover : 0);
            // A health bar once it has been hit.
            const hurt = f.hp < d.hp;
            f.bar.visible = f.barBg.visible = hurt;
            if (hurt) {
                const top = f.pos.clone().setY(f.pos.y + (d.hover ? 1.3 : f.rig.chest * 1.45 + 0.4));
                f.barBg.position.copy(top);
                f.bar.position.copy(top);
                f.barBg.scale.set(1.4, 0.12, 1);
                f.bar.scale.set(1.4 * Math.max(0, f.hp / d.hp), 0.12, 1);
                (f.bar.material as THREE.SpriteMaterial).color.setHex(this.time - f.hitAt < 0.1 ? 0xffffff : 0xff3a30);
            }
        }
        // Bars grow from their left end: shift them left by half their length, in screen terms.
        const cam = this.lastCamera;
        if (cam) {
            const left = new THREE.Vector3(-1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(0.7);
            for (const f of this.foes) if (f.bar.visible) { f.bar.position.add(left); f.barBg.position.add(left); }
        }
    }

    private lastCamera: THREE.Camera | null = null;
    setCamera(c: THREE.Camera) { this.lastCamera = c; }

    private animateFoe(f: Foe, moving: boolean) {
        const p = f.rig.parts, s = Math.sin(f.phase), t = this.time;
        switch (f.kind) {
            case 'skitter':
                for (let i = 0; i < 8; i++) {
                    const leg = p[`leg${i}`];
                    const ph = f.phase * 2 + (i % 2 ? 0 : Math.PI) + Math.floor(i / 2) * 0.8;
                    leg.rotation.y = Math.sin(ph) * 0.4 * (moving ? 1 : 0.2);
                    leg.rotation.z = Math.max(0, Math.cos(ph)) * 0.3 * (i % 2 ? -1 : 1);
                }
                p.body.position.y = 0.5 + Math.abs(s) * 0.05;
                break;
            case 'sentinel':
                p.legL.rotation.x = s * 0.4 * (moving ? 1 : 0);
                p.legR.rotation.x = -s * 0.4 * (moving ? 1 : 0);
                p.hull.position.y = 2.4 + Math.abs(Math.cos(f.phase)) * 0.12;
                break;
            case 'wraith':
                p.shards.rotation.y = t * 1.5 + f.seed;
                for (let i = 0; i < 3; i++) p[`tail${i}`].rotation.z = Math.sin(t * 3 + i) * 0.3;
                break;
            case 'brute':
                p.legL.rotation.x = s * 0.5 * (moving ? 1 : 0);
                p.legR.rotation.x = -s * 0.5 * (moving ? 1 : 0);
                p.armL.rotation.x = -s * 0.6 * (moving ? 1 : 0.1) - 0.2;
                p.armR.rotation.x = s * 0.6 * (moving ? 1 : 0.1) - 0.2 - (f.cooldown > f.def.cooldown - 0.3 ? 1.4 : 0);
                p.body.position.y = 1.6 + Math.abs(Math.cos(f.phase)) * 0.1;
                break;
        }
    }

    /** Foes for the job at hand, and now and then a chance meeting. */
    private spawning(dt: number) {
        const log = this.ctx.game.log;
        const m = log.active;
        this.missionSpawnIn -= dt;
        if (m && m.state === 'active' && this.missionSpawnIn <= 0) {
            for (const o of m.objectives) {
                if (o.type !== 'kill' || !isGround(o.enemy) || o.done >= o.count) continue;
                const cap = o.enemy === 'brute' ? 1 : o.enemy === 'sentinel' ? 2 : 3;
                const need = Math.min(o.count - o.done, cap) - this.foes.filter(f => f.kind === o.enemy && f.dying < 0).length;
                if (need > 0) {
                    this.spawnFoes(o.enemy, need);
                    this.ctx.toast(`⚠ Цель задания рядом: ${FOES[o.enemy].name} — ${need}. ЛКМ — огонь`);
                }
                this.missionSpawnIn = 6;
            }
        }
        if (this.foes.some(f => f.dying < 0)) return;
        this.encounterIn -= dt;
        if (this.encounterIn <= 0) {
            this.encounterIn = 50 + this.rng() * 50;
            const kind = this.ctx.foes[Math.floor(this.rng() * this.ctx.foes.length)];
            const n = kind === 'skitter' ? 2 + Math.floor(this.rng() * 3) : kind === 'brute' ? 1 : 1 + Math.floor(this.rng() * 2);
            this.spawnFoes(kind, n);
            this.ctx.toast(`⚠ ${FOES[kind].name}${n > 1 ? ` ×${n}` : ''} — приближаются! ЛКМ — огонь (клик — захватить мышь)`);
        }
    }

    // -----------------------------------------------------------------------
    // Beings.
    // -----------------------------------------------------------------------

    /** The locals come out to meet the ship, each from its own side. */
    private placeBeings() {
        this.clearBeings();
        const rng = mulberry32(Math.floor(this.shipPos.x * 7 + this.shipPos.z * 13) ^ 0x9e37);
        this.ctx.beings.forEach((spec, i) => {
            let home: THREE.Vector2 | null = null;
            for (let k = 0; k < 20 && !home; k++) {
                const a = this.shipYaw + Math.PI + (i - (this.ctx.beings.length - 1) / 2) * 0.9 + (rng() - 0.5) * 0.4;
                const r = 16 + i * 5 + rng() * 10 + k * 3;
                const x = this.shipPos.x + Math.sin(a) * -r, z = this.shipPos.z + Math.cos(a) * r;
                const g = this.ctx.groundAt(x, z);
                if (this.ctx.sea !== null && g < this.ctx.sea + 0.5) continue;
                home = new THREE.Vector2(x, z);
            }
            if (!home) return;
            const rig = makeBeing(spec);
            this.ctx.scene.add(rig.root);
            // They start further out and walk in.
            const start = new THREE.Vector2(home.x + (home.x - this.shipPos.x) * 1.6, home.y + (home.y - this.shipPos.z) * 1.6);
            const sg = this.ctx.groundAt(start.x, start.y);
            const from = this.ctx.sea !== null && sg < this.ctx.sea + 0.5 ? home.clone() : start;
            // Its building site, a little to the side of where it lives.
            const side = new THREE.Vector2(home.x - this.shipPos.x, home.y - this.shipPos.z).normalize();
            const siteAt = new THREE.Vector2(home.x - side.y * 9 + side.x * 6, home.y + side.x * 9 + side.y * 6);
            const siteG = this.ctx.groundAt(siteAt.x, siteAt.y);
            let build: Being['build'] = null;
            if (this.ctx.sea === null || siteG > this.ctx.sea + 0.5) {
                const s = makeStructure(spec.kind, spec.color);
                const key = `${this.ctx.planet}:${spec.kind}`;
                s.group.position.set(siteAt.x, siteG - 0.05, siteAt.y);
                s.group.rotation.y = rng() * Math.PI * 2;
                this.ctx.scene.add(s.group);
                build = { s, at: siteAt, key, progress: progress.data.builds?.[key] ?? 0.08 };
                this.showStages(build);
            }
            this.beings.push({
                spec, rig, pos: new THREE.Vector3(from.x, this.ctx.groundAt(from.x, from.y), from.y), yaw: 0, home, target: home.clone(),
                state: 'walk', timer: 0, phase: rng() * 10, hailed: false, shadow: this.makeShadow(rig.radius),
                build, chatWith: null, toSite: false,
            });
        });
    }

    private chatIn = 15;

    /** Now and then two of them meet halfway and have a chat. */
    private chats(dt: number) {
        this.chatIn -= dt;
        if (this.chatIn > 0) return;
        this.chatIn = 20 + Math.random() * 25;
        const free = this.beings.filter(b => b.state === 'work' && !b.chatWith && b.pos.distanceTo(this.robotPos) > 6);
        if (free.length < 2) return;
        const a = free[Math.floor(Math.random() * free.length)];
        const b = free.filter(x => x !== a).sort((x, y) => x.pos.distanceTo(a.pos) - y.pos.distanceTo(a.pos))[0];
        if (!b || a.pos.distanceTo(b.pos) > 60) return;
        const mid = new THREE.Vector2((a.pos.x + b.pos.x) / 2, (a.pos.z + b.pos.z) / 2);
        const dir = new THREE.Vector2(a.pos.x - b.pos.x, a.pos.z - b.pos.z).normalize().multiplyScalar(1.1);
        for (const [x, other, s] of [[a, b, 1], [b, a, -1]] as const) {
            x.chatWith = other;
            x.toSite = false;
            x.target = mid.clone().addScaledVector(dir, s);
            x.state = 'walk';
        }
        const line = CHATTER[Math.floor(Math.random() * CHATTER.length)];
        this.pendingChat = { a, b, line, shown: 0 };
    }
    private pendingChat: { a: Being; b: Being; line: string[]; shown: number } | null = null;

    /** Overheard, if the robot is near enough. */
    private overhear(dt: number) {
        const c = this.pendingChat;
        if (!c) return;
        if (c.a.state !== 'chat' || c.b.state !== 'chat') { if (c.a.state === 'work' && c.b.state === 'work' && c.shown > 0) this.pendingChat = null; return; }
        c.shown += dt;
        const near = Math.min(c.a.pos.distanceTo(this.robotPos), c.b.pos.distanceTo(this.robotPos)) < 30;
        if (!near || this.dialog.open) return;
        if (c.shown < dt * 1.5) this.ctx.toast(`${c.a.spec.emoji} ${c.a.spec.name.split(' ').pop()}: «${c.line[0]}»`);
        else if (c.shown >= 4 && c.shown - dt < 4) this.ctx.toast(`${c.b.spec.emoji} ${c.b.spec.name.split(' ').pop()}: «${c.line[1]}»`);
    }

    /** Talking with the hands (or the lights). */
    private gesture(b: Being) {
        const p = b.rig.parts, t = this.time + b.phase;
        if (p.armR && b.spec.kind !== 'golem') { p.armR.rotation.x = -0.6 + Math.sin(t * 3) * 0.35; p.armR.rotation.z = Math.sin(t * 2) * 0.2; }
        if (p.head) p.head.rotation.x = Math.sin(t * 2.3) * 0.12;
        if (p.orbit) p.orbit.rotation.y = t * 4;
        if (b.spec.kind === 'crawler') p.body.rotation.x = Math.sin(t * 4) * 0.08;
        if (b.spec.kind === 'rover') p.cam.rotation.y = Math.sin(t * 1.5) * 0.4;
    }

    private showStages(build: NonNullable<Being['build']>) {
        const n = build.s.stages.length;
        const shown = Math.ceil(build.progress * n);
        build.s.stages.forEach((o, i) => { o.visible = i < shown; });
        build.s.scaffold.visible = build.progress < 1;
    }

    private hails() {
        for (const b of this.beings) {
            const d = b.pos.distanceTo(this.robotPos);
            if (!b.hailed && d < 24) {
                b.hailed = true;
                this.ctx.toast(`${b.spec.emoji} ${b.spec.name}: «${b.spec.script.hail}» — подойдите и нажмите E`);
            }
        }
    }

    private updateBeings(dt: number) {
        for (const b of this.beings) {
            const d = b.pos.distanceTo(this.robotPos);
            const talking = this.talkingTo === b;
            let moving = false;
            if (talking || (d < 5 && this.mode === 'walk')) {
                // Turn to the robot and wait.
                b.state = 'greet';
                const want = Math.atan2(-(this.robotPos.x - b.pos.x), -(this.robotPos.z - b.pos.z));
                b.yaw += wrap(want - b.yaw) * (1 - Math.exp(-4 * dt));
            } else {
                if (b.state === 'greet') { b.state = 'work'; b.timer = 2; }
                if (b.state === 'walk' && b.target) {
                    const to = new THREE.Vector2(b.target.x - b.pos.x, b.target.y - b.pos.z);
                    const dist = to.length();
                    if (dist < (b.chatWith ? 1.6 : 0.8)) {
                        if (b.chatWith) { b.state = 'chat'; b.timer = 12; }
                        else { b.state = 'work'; b.timer = b.toSite ? 14 + Math.random() * 10 : 6 + Math.random() * 8; }
                    } else {
                        to.normalize();
                        const step = Math.min(dist, b.spec.speed * dt);
                        const nx = b.pos.x + to.x * step, nz = b.pos.z + to.y * step;
                        if (this.ctx.sea === null || this.ctx.groundAt(nx, nz) > this.ctx.sea + 0.3) { b.pos.x = nx; b.pos.z = nz; moving = true; }
                        else { b.target = null; b.chatWith = null; }
                        const want = Math.atan2(-to.x, -to.y);
                        b.yaw += wrap(want - b.yaw) * (1 - Math.exp(-5 * dt));
                    }
                } else if (b.state === 'chat') {
                    // Face the other one and talk; an overheard line now and then.
                    const o = b.chatWith;
                    if (o) {
                        const want = Math.atan2(-(o.pos.x - b.pos.x), -(o.pos.z - b.pos.z));
                        b.yaw += wrap(want - b.yaw) * (1 - Math.exp(-4 * dt));
                    }
                    b.timer -= dt;
                    if (b.timer <= 0 || !o || (o.state !== 'chat' && o.state !== 'walk')) { b.chatWith = null; b.state = 'work'; b.timer = 2; }
                } else if (b.state === 'work') {
                    b.timer -= dt;
                    // Building: the work goes on while it stands at the site.
                    if (b.toSite && b.build && b.build.progress < 1) {
                        const was = b.build.progress;
                        b.build.progress = Math.min(1, was + dt / 160);
                        this.showStages(b.build);
                        if (Math.random() < dt * 6) {
                            const p = new THREE.Vector3(b.build.at.x + (Math.random() - 0.5) * 6, 0, b.build.at.y + (Math.random() - 0.5) * 6);
                            p.y = this.ctx.groundAt(p.x, p.z) + Math.random() * 3;
                            this.sparks.emit(p, new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2), new THREE.Color(3, 2.2, 0.8), 0.1, 0.5, 1);
                        }
                        if (b.build.progress >= 1) {
                            b.build.s.scaffold.visible = false;
                            if (b.pos.distanceTo(this.robotPos) < 80) this.ctx.toast(`${b.spec.emoji} ${b.spec.name} достраивает ${b.build.s.name}!`);
                        }
                        (progress.data.builds ??= {})[b.build.key] = b.build.progress;
                    }
                    if (b.timer <= 0) {
                        b.toSite = false;
                        if (b.build && b.build.progress < 1 && Math.random() < 0.6) {
                            // Back to the building site.
                            const a = Math.random() * Math.PI * 2;
                            b.target = new THREE.Vector2(b.build.at.x + Math.cos(a) * 5.5, b.build.at.y + Math.sin(a) * 5.5);
                            b.toSite = true;
                        } else {
                            const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 16;
                            b.target = new THREE.Vector2(b.home.x + Math.cos(a) * r, b.home.y + Math.sin(a) * r);
                        }
                        b.state = 'walk';
                    }
                } else { b.state = 'work'; b.timer = 3; }
            }
            b.pos.y = this.ctx.groundAt(b.pos.x, b.pos.z);
            b.phase += dt * (moving ? b.spec.speed * 3.2 : 1);
            this.animateBeing(b, moving, b.state === 'work' && !b.toSite ? true : b.state === 'work');
            if (b.state === 'chat') this.gesture(b);
            b.rig.root.position.copy(b.pos);
            b.rig.root.rotation.y = b.yaw;
            this.placeShadow(b.shadow, b.pos.x, b.pos.z, 0);
        }
    }

    private animateBeing(b: Being, moving: boolean, working: boolean) {
        const p = b.rig.parts, s = Math.sin(b.phase), t = this.time;
        switch (b.spec.kind) {
            case 'android':
            case 'colonist': {
                const swing = moving ? 0.5 : 0;
                p.legL.rotation.x = s * swing;
                p.legR.rotation.x = -s * swing;
                p.armL.rotation.x = -s * swing * 0.8;
                p.armR.rotation.x = s * swing * 0.8;
                p.body.position.y = (b.spec.kind === 'colonist' ? 0.92 * 1 : 0.92) + (moving ? Math.abs(Math.cos(b.phase)) * 0.04 : 0);
                p.head.rotation.y = moving ? 0 : Math.sin(t * 0.5 + b.phase) * 0.4;
                if (b.spec.kind === 'android') {
                    // Scanning: the arm out, a fan of light sweeping the ground.
                    p.beam.visible = working;
                    if (working) { p.armR.rotation.x = -1.1; p.armR.rotation.z = Math.sin(t * 1.3) * 0.4; } else p.armR.rotation.z = 0;
                } else {
                    // Repairs: kneeling, the right arm working, sparks flying.
                    p.sparks.visible = working && Math.sin(t * 23) > 0.2;
                    if (working) {
                        p.body.position.y = 0.6;
                        p.legL.rotation.x = -1.4; p.legR.rotation.x = 0.2;
                        p.armR.rotation.x = -0.8 + Math.sin(t * 6) * 0.25;
                        if (Math.random() < 0.15) {
                            b.rig.root.updateMatrixWorld(true);
                            const w = new THREE.Vector3().setFromMatrixPosition(p.sparks.matrixWorld);
                            this.sparks.emit(w, new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3), new THREE.Color(3, 2.2, 0.8), 0.08, 0.4, 1);
                        }
                    }
                }
                break;
            }
            case 'crawler': {
                for (let i = 0; i < 6; i++) {
                    const ph = b.phase * 1.6 + (i % 2 ? 0 : Math.PI) + Math.floor(i / 2) * 1.1;
                    p[`leg${i}`].rotation.y = Math.sin(ph) * 0.35 * (moving ? 1 : 0.1);
                }
                p.body.position.y = 0.55 + (moving ? Math.abs(s) * 0.03 : 0);
                // Digging: nose down, dirt flying.
                p.body.rotation.x = working ? -0.25 + Math.sin(t * 8) * 0.05 : 0;
                if (working && Math.random() < 0.3) {
                    const nose = b.pos.clone().add(new THREE.Vector3(0, 0.2, -0.9).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw));
                    this.particles.emit(nose, new THREE.Vector3((Math.random() - 0.5) * 2, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 2), this.ctx.dustColor, 0.25, 1, 1);
                }
                break;
            }
            case 'sprite': {
                p.body.position.y = 1.6 + Math.sin(t * 1.7 + b.phase) * 0.25 + (working ? Math.sin(t * 3) * 0.4 + 0.3 : 0);
                p.orbit.rotation.y = t * (working ? 5 : 1.5);
                p.orbit.rotation.x = Math.sin(t * 0.7) * 0.4;
                break;
            }
            case 'golem': {
                const swing = moving ? 0.35 : 0;
                p.legL.rotation.x = s * swing;
                p.legR.rotation.x = -s * swing;
                p.armL.rotation.x = -s * swing;
                p.body.position.y = 1.35 + (moving ? Math.abs(Math.cos(b.phase)) * 0.06 : 0);
                if (working) {
                    // Crushing rock: the fist comes down, dust flies.
                    const cyc = (t * 0.8 + b.phase) % 1;
                    p.armR.rotation.x = cyc < 0.6 ? -2.4 * (cyc / 0.6) : -2.4 * (1 - (cyc - 0.6) / 0.4);
                    if (cyc > 0.97) {
                        const fist = b.pos.clone().add(new THREE.Vector3(0.7, 0.1, -0.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw));
                        this.particles.burst(fist, 6, 2, this.ctx.dustColor, 0.5, 1.3, 0.3, 1);
                    }
                } else p.armR.rotation.x = s * swing;
                break;
            }
            case 'rover': {
                for (let i = 0; i < 6; i++) p[`wheel${i}`].rotation.x += (moving ? b.spec.speed / 0.26 : 0) * 0.016;
                p.cam.rotation.y = Math.sin(t * 0.4 + b.phase) * 0.8;
                p.arm.rotation.x = working ? 0.2 : -1.2;
                p.drill.rotation.y += working ? 0.6 : 0;
                if (working && Math.random() < 0.2) {
                    b.rig.root.updateMatrixWorld(true);
                    const w = new THREE.Vector3().setFromMatrixPosition(p.drill.matrixWorld);
                    this.particles.emit(w, new THREE.Vector3((Math.random() - 0.5) * 1.5, 1 + Math.random(), (Math.random() - 0.5) * 1.5), this.ctx.dustColor, 0.2, 0.9, 1);
                }
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Things to pick up.
    // -----------------------------------------------------------------------

    private updateItems(dt: number) {
        const m = this.ctx.game.log.active;
        const want = new Map<string, number>();
        if (m && m.state === 'active') for (const o of m.objectives) if (o.type === 'collect' && o.done < o.count) want.set(o.item, o.count - o.done);
        // Lay out what the job needs round the landing site.
        if (this.mode === 'walk' && m) {
            for (const [item, n] of want) {
                const have = this.items.filter(i => i.mission === m.id && i.item === item).length;
                if (have >= n) continue;
                const rng = mulberry32([...m.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) ^ Math.floor(this.shipPos.x));
                for (let k = 0; k < n - have; k++) {
                    for (let tries = 0; tries < 15; tries++) {
                        const a = rng() * Math.PI * 2, r = 30 + rng() * 110;
                        const x = this.shipPos.x + Math.cos(a) * r, z = this.shipPos.z + Math.sin(a) * r;
                        const g = this.ctx.groundAt(x, z);
                        if (this.ctx.sea !== null && g < this.ctx.sea + 0.5) continue;
                        const mesh = makeItem(this.ctx.itemColor);
                        mesh.position.set(x, g, z);
                        this.ctx.scene.add(mesh);
                        this.items.push({ mesh, pos: new THREE.Vector3(x, g, z), mission: m.id, item });
                        break;
                    }
                }
                this.ctx.toast(`Столбы света отмечают, где лежат ${item}. Подойдите — робот подберёт сам`);
            }
        }
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            it.mesh.rotation.y += dt * 0.8;
            it.mesh.children.forEach((c, k) => { if (c.name !== 'pillar') c.position.y = 0.15 + Math.sin(this.time * 2 + k) * 0.05; });
            const pillar = it.mesh.getObjectByName('pillar');
            if (pillar) pillar.visible = it.pos.distanceTo(this.robotPos) > 6;
            const stale = !m || m.id !== it.mission || !want.has(it.item);
            if (this.mode === 'walk' && !stale && it.pos.distanceTo(this.robotPos) < 2.2) {
                this.ctx.game.log.collect(it.item);
                this.sparks.burst(it.pos.clone().setY(it.pos.y + 0.3), 30, 3, new THREE.Color(this.ctx.itemColor).multiplyScalar(2.5), 0.2, 0.7, -0.2);
                const o = m?.objectives.find(x => x.type === 'collect' && x.item === it.item);
                if (o && o.type === 'collect') this.ctx.toast(`Подобрано: ${it.item} ${o.done}/${o.count}`);
                this.removeItem(i);
            } else if (stale) this.removeItem(i);
        }
    }

    private removeItem(i: number) {
        const it = this.items[i];
        this.ctx.scene.remove(it.mesh);
        this.disposeTree(it.mesh);
        this.items.splice(i, 1);
    }

    // -----------------------------------------------------------------------
    // HUD, buttons, status, saving.
    // -----------------------------------------------------------------------

    private renderHud() {
        const walking = this.mode === 'walk';
        this.hud.cross.hidden = !walking || document.pointerLockElement !== this.ctx.canvas;
        this.hud.fuel.style.width = `${this.fuel * 100}%`;
        let prompt = '';
        if (walking && !this.dialog.open) {
            const b = this.nearestBeing();
            if (this.driving) prompt = 'E — выйти из вездехода';
            else if (this.vehicle && this.carState === 'parked' && this.vehicle.pos.distanceTo(this.robotPos) < 4.5) prompt = 'E — сесть в вездеход';
            else if (b) prompt = `E — поговорить: ${b.spec.emoji} ${b.spec.name} · ${b.spec.species.split(',')[0]}`;
            else if (this.robotPos.distanceTo(this.rampEnd()) < BOARD_M) prompt = 'F — подняться на борт и взлететь';
            else if (document.pointerLockElement !== this.ctx.canvas && this.time - this.walkSince < 12) prompt = 'Клик по сцене — захватить мышь для обзора и стрельбы';
        } else if (this.mode === 'dead') prompt = 'Робот разрушен — ремонтный отсек восстанавливает его…';
        if (this.hud.prompt.textContent !== prompt) this.hud.prompt.textContent = prompt;
        this.hud.prompt.hidden = !prompt;
    }

    actions(): Action[] {
        if (this.mode !== 'walk') return [];
        const list: Action[] = [];
        const b = this.nearestBeing();
        if (b) list.push({ label: `💬 ${b.spec.name} (E)`, title: b.spec.species, run: () => this.talk(b) });
        if (this.driving) list.push({ label: '🚶 Выйти (E)', run: () => this.getOut() });
        else list.push({ label: '🚙 Вездеход (G)', title: 'Вызвать вездеход из трюма корабля', run: () => this.summon() });
        list.push({ label: '🚀 На борт (F)', title: 'Вернуться к кораблю и взлететь', run: () => this.board() });
        return list;
    }

    status(): string {
        if (this.mode === 'exiting') return 'Трап опускается, робот выходит…';
        if (this.mode === 'boarding') return 'Робот поднимается на борт…';
        if (this.mode === 'dead') return 'Робот разрушен';
        const toShip = Math.round(this.robotPos.distanceTo(this.shipPos));
        if (this.driving && this.vehicle) return `За рулём вездехода · ${Math.abs(this.vehicle.speed * 3.6).toFixed(0)} км/ч · до корабля ${toShip} м`;
        const hs = Math.hypot(this.robotVel.x, this.robotVel.z);
        const g = this.ctx.gravity;
        const note = g < 0.5 ? ' (гравизахваты)' : g < 3 ? ' — низкая гравитация, прыжки высокие' : '';
        return `Пешком · ${hs.toFixed(1)} м/с · g = ${g.toFixed(2)} м/с²${note} · до корабля ${toShip} м · ранец ${Math.round(this.fuel * 100)} %`;
    }

    /** Where the head lamp is and where it points, and how bright it is (for the ground shader). */
    lamp(): { pos: THREE.Vector3; dir: THREE.Vector3; power: number } {
        const l = this.robot.headlamp;
        const pos = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld);
        const dir = new THREE.Vector3().setFromMatrixPosition(l.target.matrixWorld).sub(pos).normalize();
        return { pos, dir, power: this.robot.root.visible ? l.intensity * 0.05 : 0 };
    }

    /** Around what to draw the grass and pebbles, and how high the eye is. */
    get focus(): THREE.Vector3 { return this.robotPos; }

    saveState(): SurfaceState | null {
        if (this.mode === 'off' || this.mode === 'boarding') return null;
        return { ship: [this.shipPos.x, this.shipPos.y, this.shipPos.z, this.shipYaw], robot: [this.robotPos.x, this.robotPos.y, this.robotPos.z], camYaw: this.camYaw };
    }

    restore(s: SurfaceState) {
        this.land(new THREE.Vector3(s.ship[0], s.ship[1], s.ship[2]), s.ship[3], true);
        this.robotPos.set(s.robot[0], this.ctx.groundAt(s.robot[0], s.robot[2]), s.robot[2]);
        this.camYaw = s.camYaw;
    }

    private clearBeings() {
        for (const b of this.beings) {
            this.ctx.scene.remove(b.rig.root, b.shadow);
            this.disposeTree(b.rig.root);
            if (b.build) { this.ctx.scene.remove(b.build.s.group); this.disposeTree(b.build.s.group); }
        }
        this.pendingChat = null;
        this.beings = [];
    }

    private clearLife() {
        this.clearBeings();
        for (const f of this.foes) { this.ctx.scene.remove(f.rig.root, f.bar, f.barBg, f.shadow); this.disposeTree(f.rig.root); }
        this.foes = [];
        for (const b of this.bolts) this.ctx.scene.remove(b.mesh);
        this.bolts = [];
        while (this.items.length) this.removeItem(0);
    }

    private disposeTree(o: THREE.Object3D) {
        o.traverse(x => {
            const m = x as THREE.Mesh;
            if (m.isMesh && m.geometry !== this.shadowGeo && m.geometry !== this.boltGeo) m.geometry.dispose();
        });
    }

    dispose() {
        this.stowCar();
        this.clearLife();
        if (this.ship) { this.ctx.scene.remove(this.ship); this.disposeTree(this.ship); }
        this.ctx.scene.remove(this.robot.root);
        this.robot.dispose();
        this.particles.dispose();
        this.sparks.dispose();
        this.dialog.dispose();
        this.hud.root.remove();
        this.offLook();
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        this.ctx.canvas.removeEventListener('pointerdown', this.onDown);
        window.removeEventListener('pointerup', this.onUp);
        window.removeEventListener('pointermove', this.onMove);
        this.ctx.canvas.removeEventListener('wheel', this.onWheel);
        this.ctx.canvas.removeEventListener('contextmenu', this.onContext);
    }
}
