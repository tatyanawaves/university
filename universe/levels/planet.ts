import * as THREE from 'three';
import { Action, CameraState, Level, LevelHost, row } from '../common';
import { AtmosphereParams, scatter, SurfaceParams, sunTransmittance, surfaceFor } from '../atmosphere';
import { FlyController, SHIP_HELP } from '../flight';
import { ShipGame } from '../game/shipGame';
import { Mission } from '../game/missions';
import { Scatter } from '../game/scatter';
import { SurfaceGame } from '../game/surface';
import { beingsFor, foesFor } from '../game/surfaceLife';
import type { PlanetKind } from '../mandelbrot';
import { fmtNum } from '../physics';
import { SKY_FRAG, SKY_VERT, TERRAIN_FRAG, TERRAIN_VERT, WATER_FRAG, WATER_VERT } from '../planetShaders';
import { terrainHeight, TerrainParams } from '../terrain';

export interface PlanetVisit {
    name: string;
    kind: PlanetKind | 'moon';
    radiusKm: number;
    gravity: number;
    dayDays: number;
    seed: number;
    /** Identifies the system, so missions are kept per place. */
    systemKey: string;
    /** The system's name and its bodies, for the jobs the locals hand out. */
    system?: string;
    bodies?: string[];
}

const REACH = 90_000; // m, terrain radius around the camera
/** Ground grid: 2 m between vertices under the robot's feet, widening to ~1 km at the horizon. */
const GRID = 512;
const NEAR_SPACING = 2;
/** Water grid: finer still near the viewer, where the waves really move the surface. */
const WATER_GRID = 384;
const WATER_SPACING = 0.8;
/** Below this height over the ground the ship can set down (L). */
const LANDING_ALT = 4000;

/** Surface missions: something is always stirring below. */
function surfaceMissions(name: string, hasAir: boolean): Mission[] {
    const m = (id: string, title: string, brief: string, spawn: Mission['spawn'], kind: Mission['objectives'][number], reward: number): Mission => ({
        id, title, brief, location: name, triggerKm: 1e9, spawn, objectives: [kind], reward, state: 'available', spawned: false, startedAt: 0,
    });
    const list = [
        m('s-colony', 'Оборона колонии', `Кристаллиды атакуют поселение на поверхности (${name}).`,
            [{ kind: 'crystal', count: 8 }], { type: 'kill', enemy: 'crystal', count: 8, done: 0 }, 500),
        m('s-drones', 'Сбить разведчиков', 'Чужие дроны картографируют местность.',
            [{ kind: 'drone', count: 5 }], { type: 'kill', enemy: 'drone', count: 5, done: 0 }, 400),
    ];
    if (hasAir) {
        list.push(m('s-leviathan', 'Небесный левиафан', 'В облаках кружит исполинское существо.',
            [{ kind: 'leviathan', count: 1 }], { type: 'kill', enemy: 'leviathan', count: 1, done: 0 }, 2000));
    }
    return list;
}

/** Surface pressure, bar, for the bodies we know. */
const PRESSURE: Record<string, number> = { 'Земля': 1.013, 'Марс': 0.006, 'Венера': 92, 'Титан': 1.45 };

/** Colour of the samples lying about, by world. */
function itemColor(name: string, feature: number): number {
    const byName: Record<string, number> = { 'Земля': 0x6dffb0, 'Луна': 0x9ad8ff, 'Марс': 0xff9a5a, 'Венера': 0xff6a40, 'Ио': 0xfff060, 'Титан': 0xffb060 };
    return byName[name] ?? ([3, 6, 8].includes(feature) ? 0x90f0ff : feature === 14 ? 0xff7040 : 0x80ffe0);
}

/** A grid denser near the centre: `spacing` m between vertices at the middle, the rest out to REACH. */
function grid(n: number, spacing: number, k2: number): THREE.BufferGeometry {
    const g = new THREE.PlaneGeometry(2, 2, n, n);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const k1 = (spacing * n) / (2 * REACH), k3 = 1 - k1 - k2;
    const warp = (u: number) => REACH * (k1 * u + k2 * u * Math.abs(u) + k3 * u * u * u);
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, warp(pos.getX(i)), 0, warp(pos.getZ(i)));
    return g;
}

type Mode = 'flight' | 'landing' | 'surface' | 'takeoff';

export class PlanetLevel implements Level {
    readonly scene = new THREE.Scene();
    // The sky dome must sit well inside the far plane, or its triangles get clipped away.
    readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 2e7);
    readonly title: string;
    readonly bloom = { strength: 0.35, radius: 0.4, threshold: 1.2 };
    /** The ground shader is heavy (shadows, erosion noise, clouds): render at one sample per CSS pixel. */
    readonly maxPixelRatio = 1;
    readonly help = `${SHIP_HELP} · L — посадка и выход робота · Пробел/ЛКМ — огонь · V — вид · M — миссии · наберите высоту — выход в космос`;
    private surface: SurfaceParams;
    private terrain: TerrainParams;
    private pilot = new THREE.PerspectiveCamera(65, 1, 0.1, 2e7);
    private ctl: FlyController;
    private game: ShipGame;
    private foot: SurfaceGame;
    private scatterer: Scatter;
    private sky: THREE.Mesh;
    private ground: THREE.Mesh;
    private water: THREE.Mesh | null = null;
    private uniforms: Record<string, THREE.IUniform>;
    private hourAngle = -1.15; // morning
    private latitude = 0.7;
    private daySpeed = 120;
    private time = 0;
    private speed = 0;
    private width = 1;
    private height = 1;
    private exitAltitude: number;
    private leaving = false;
    private sunColor = new THREE.Vector3();
    private mode: Mode = 'flight';
    private seq = { t: 0, from: new THREE.Vector3(), fromQ: new THREE.Quaternion(), pad: new THREE.Vector3(), yaw: 0, dur: 1 };
    private lastPos = new THREE.Vector3();
    private velocity = new THREE.Vector3();
    private pmrem: THREE.PMREMGenerator;
    private envRT: THREE.WebGLRenderTarget | null = null;
    private envScene = new THREE.Scene();
    private envSky: THREE.Mesh;
    private envClock = 0;

    private onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        if (e.code === 'KeyL' && this.mode === 'flight') this.startLanding();
    };

    constructor(private host: LevelHost, private visit: PlanetVisit) {
        this.title = `${visit.name}: поверхность`;
        this.surface = surfaceFor(visit.name, visit.kind, visit.radiusKm, visit.gravity);
        const s = this.surface;
        const look = s.look;
        this.terrain = {
            // A small offset: the noise stays in the range where the GPU's float32 and the CPU agree.
            relief: s.relief, craters: s.craters, seed: (visit.seed % 97) * 0.37 + 11.3,
            seaBias: s.sea === null ? 0 : 0.08,
        };
        const a: AtmosphereParams | null = s.atmosphere;
        this.exitAltitude = a ? (a.top - 1) * s.radiusM * 1.1 : 60_000;
        const mat = look.material;
        const liquid = look.liquid;
        const clouds = look.clouds;

        // Uniforms shared by sky, ground, water, trees, grass and rocks.
        this.uniforms = {
            uHasAtmo: { value: a ? 1 : 0 },
            uTop: { value: a?.top ?? 1.01 },
            uBetaR: { value: new THREE.Vector3(...(a?.betaR ?? [0, 0, 0])) },
            uBetaM: { value: new THREE.Vector3(...(a?.betaM ?? [0, 0, 0])) },
            uHR: { value: a?.hR ?? 0.001 },
            uHM: { value: a?.hM ?? 0.001 },
            uG: { value: a?.g ?? 0.76 },
            uForwardTint: { value: new THREE.Vector3(...(a?.forwardTint ?? [1, 1, 1])) },
            uMulti: { value: a?.multi ?? 0 },
            uAbsorbM: { value: new THREE.Vector3(...(a?.absorbM ?? [0, 0, 0])) },
            uSunIntensity: { value: a?.sunIntensity ?? 20 },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uPlanetR: { value: s.radiusM },
            uPlanetRV: { value: s.radiusM },
            uCamAlt: { value: 100 },
            uSunColor: { value: new THREE.Vector3(1, 1, 1) },
            uAmbient: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
            uZenith: { value: new THREE.Vector3() },
            uHorizon: { value: new THREE.Vector3() },
            uRelief: { value: this.terrain.relief },
            uSeed: { value: this.terrain.seed },
            uSeaBias: { value: this.terrain.seaBias },
            uCraters: { value: this.terrain.craters ? 1 : 0 },
            uPalette: { value: look.flora ? 0 : 1 },
            uColA: { value: new THREE.Vector3(...mat.a) },
            uColB: { value: new THREE.Vector3(...mat.b) },
            uRock: { value: new THREE.Vector3(...mat.rock) },
            uColC: { value: new THREE.Vector3(...mat.c) },
            uColD: { value: new THREE.Vector3(...mat.d) },
            uFeature: { value: mat.feature },
            uRoughness: { value: mat.rough },
            uSea: { value: s.sea ?? -1e5 },
            uOffset: { value: new THREE.Vector2() },
            uTime: { value: 0 },
            uDeep: { value: new THREE.Vector3(...(liquid?.deep ?? [0, 0.025, 0.05])) },
            uShallow: { value: new THREE.Vector3(...(liquid?.shallow ?? [0.02, 0.2, 0.2])) },
            uMurk: { value: liquid?.murk ?? 0.1 },
            uWaveAmp: { value: liquid?.waves ?? 0.5 },
            uCloudCover: { value: clouds?.cover ?? 0 },
            uCloudBase: { value: clouds?.base ?? 2000 },
            uCloudTop: { value: clouds?.top ?? 4000 },
            uCloudDensity: { value: clouds?.density ?? 0 },
            uCloudAlbedo: { value: new THREE.Vector3(...(clouds?.albedo ?? [1, 1, 1])) },
            uWind: { value: new THREE.Vector2() },
            uLampPos: { value: new THREE.Vector3() },
            uLampDir: { value: new THREE.Vector3(0, -1, 0) },
            uLampPower: { value: 0 },
        };

        this.sky = new THREE.Mesh(new THREE.SphereGeometry(1e6, 64, 32), new THREE.ShaderMaterial({
            vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false,
        }));
        this.sky.renderOrder = -1;
        this.sky.frustumCulled = false;
        this.scene.add(this.sky);

        this.ground = new THREE.Mesh(grid(GRID, NEAR_SPACING, 0.25), new THREE.ShaderMaterial({
            vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms: this.uniforms,
        }));
        this.ground.frustumCulled = false;
        this.scene.add(this.ground);

        if (s.sea !== null) {
            this.water = new THREE.Mesh(grid(WATER_GRID, WATER_SPACING, 0.15), new THREE.ShaderMaterial({
                vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: this.uniforms, transparent: true,
            }));
            this.water.frustumCulled = false;
            this.water.renderOrder = 2;
            this.scene.add(this.water);
        }

        this.scatterer = new Scatter(this.scene, this.uniforms, look, this.terrain, s.sea);

        // Arrive high over a valley, looking at the horizon.
        const start = this.findLandingSpot();
        this.pilot.position.set(start.x, Math.max(this.groundAt(start.x, start.y), s.sea ?? -1e9) + 1500, start.y);
        this.pilot.rotation.set(-0.12, 0.6, 0, 'YXZ');
        this.ctl = new FlyController(this.pilot, host.canvas, { speed: 300, minSpeed: 5, maxSpeed: 30_000, ship: true });
        this.lastPos.copy(this.pilot.position);

        const anchor = { name: visit.name, pos: new THREE.Vector3(), radius: 0 };
        this.game = new ShipGame(this.scene, host.canvas, host.labelLayer, `${visit.systemKey}:${visit.name}`,
            () => surfaceMissions(visit.name, !!a), n => (n === visit.name ? anchor : undefined), t => host.toast(t),
            { unitsPerKm: 1000, ground: (x, z) => Math.max(this.groundAt(x * 1000, z * 1000), s.sea ?? -1e9) / 1000 });
        this.game.combat.anchor = anchor;

        // Who lives here, and what roams here.
        const world = {
            planet: visit.name, bodies: visit.bodies ?? [visit.name], flora: look.flora, hasAir: !!a,
            feature: mat.feature, item: look.item, seed: visit.seed,
        };
        const foes = foesFor(visit.name, look.flora, mat.feature);
        this.foot = new SurfaceGame({
            scene: this.scene, canvas: host.canvas, toast: t => host.toast(t), game: this.game,
            groundAt: (x, z) => this.groundAt(x, z), sea: s.sea, gravity: visit.gravity, planet: visit.name,
            systemKey: visit.systemKey,
            world: { system: visit.system ?? 'эта система', bodies: visit.bodies ?? [visit.name], surface: { body: visit.name, foes, item: look.item } },
            beings: beingsFor(world), foes,
            itemColor: itemColor(visit.name, mat.feature),
            dustColor: new THREE.Color(...mat.a).multiplyScalar(1.4),
            obstacle: (x, z) => this.scatterer.obstacleAt(x, z),
        });
        this.foot.onBoarded = () => this.takeOff();

        // Reflections for the metal of the ship and the robot: the sky, re-rendered as the day turns.
        this.pmrem = new THREE.PMREMGenerator(host.renderer);
        this.envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: { uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uLow: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() } },
            vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: `uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uLow; uniform vec3 uSun; uniform vec3 uSunCol; varying vec3 vDir;
                void main() { float y = vDir.y; vec3 c = y > 0.0 ? mix(uMid, uTop, pow(y, 0.6)) : mix(uMid, uLow, pow(-y, 0.4));
                c += uSunCol * pow(max(dot(vDir, uSun), 0.0), 200.0) * 20.0; gl_FragColor = vec4(c, 1.0); }`,
        }));
        this.envScene.add(this.envSky);

        window.addEventListener('keydown', this.onKey);
        host.toast(`${visit.name}: ${a ? 'вход в атмосферу' : 'посадка на безвоздушную поверхность'}. g = ${fmtNum(visit.gravity)} м/с². L — посадка`);
    }

    private groundAt(x: number, z: number) {
        return terrainHeight(this.terrain, x, z);
    }

    private findLandingSpot(): THREE.Vector2 {
        // Prefer land a little above sea level, where there is something to see.
        const sea = this.surface.sea ?? -1e9;
        for (let k = 0; k < 200; k++) {
            const x = (k % 20) * 7000 - 60_000, z = Math.floor(k / 20) * 7000 - 30_000;
            const h = this.groundAt(x, z);
            if (h > sea + 100 && h < this.surface.relief * 0.6) return new THREE.Vector2(x, z);
        }
        return new THREE.Vector2();
    }

    private sunDirection(): THREE.Vector3 {
        const H = this.hourAngle, lat = this.latitude;
        return new THREE.Vector3(Math.sin(H), Math.cos(H) * Math.cos(lat), Math.cos(H) * Math.sin(lat)).normalize();
    }

    private static readonly TIMES: [string, number][] = [['🌅 Утро', -1.35], ['☀ Полдень', 0], ['🌇 Закат', 1.45], ['🌙 Ночь', Math.PI]];

    private altitude(): number {
        const p = this.pilot.position;
        return p.y - Math.max(this.groundAt(p.x, p.z), this.surface.sea ?? -1e9);
    }

    actions(): Action[] {
        // One button steps through the times of day; the day itself keeps turning.
        const next = PlanetLevel.TIMES.find(([, h]) => h > this.hourAngle + 0.05) ?? PlanetLevel.TIMES[0];
        const time: Action = { label: next[0], title: 'Перейти к этому времени суток', run: () => { this.hourAngle = next[1]; this.envClock = 0; } };
        if (this.mode === 'surface') {
            const [missions] = this.game.actions();
            return [...this.foot.actions(), missions, time];
        }
        if (this.mode !== 'flight') return [time];
        return [
            ...this.game.actions(),
            ...(this.altitude() < LANDING_ALT ? [{ label: '🛬 Посадка (L)', title: 'Сесть на ровную сушу поблизости, и робот выйдет на поверхность', run: () => this.startLanding() }] : []),
            time,
            { label: '⬆ В космос', run: () => this.leave() },
        ];
    }

    // -----------------------------------------------------------------------
    // Landing and take-off.
    // -----------------------------------------------------------------------

    private startLanding() {
        if (this.mode !== 'flight') return;
        const alt = this.altitude();
        if (alt > LANDING_ALT) { this.host.toast(`Слишком высоко для посадки (${fmtNum(alt / 1000)} км) — снизьтесь ниже 4 км и нажмите L`); return; }
        const p = this.pilot.position;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.pilot.quaternion).setY(0);
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const yaw = Math.atan2(-fwd.x, -fwd.z);
        const guess = p.clone().addScaledVector(fwd, Math.min(alt * 0.6 + 200, 1500));
        const pad = this.foot.findPad(guess.x, guess.z, yaw) ?? this.foot.findPad(p.x, p.z, yaw);
        if (!pad) { this.host.toast('Здесь не сесть: вода или крутые склоны. Найдите ровную сушу и нажмите L'); return; }
        this.mode = 'landing';
        this.ctl.enabled = false;
        this.ctl.stop();
        if (document.pointerLockElement) document.exitPointerLock();
        this.seq = { t: 0, from: p.clone(), fromQ: this.pilot.quaternion.clone(), pad, yaw, dur: THREE.MathUtils.clamp(p.distanceTo(pad) / 350, 3, 8) };
        this.host.toast('Автопосадка: садимся на ровную площадку…');
    }

    private landingStep(dt: number) {
        const q = this.seq;
        q.t += dt;
        const hover = q.pad.clone().setY(q.pad.y + 60);
        const level = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, q.yaw, 0, 'YXZ'));
        if (q.t < q.dur) {
            // Glide over to the pad, levelling out on the way.
            const k = THREE.MathUtils.smootherstep(q.t / q.dur, 0, 1);
            const mid = q.from.clone().lerp(hover, 0.5).setY(Math.max(q.from.y, hover.y) + 40);
            const a = q.from.clone().lerp(mid, k), b = mid.clone().lerp(hover, k);
            this.pilot.position.copy(a.lerp(b, k));
            this.pilot.quaternion.copy(q.fromQ).slerp(level, Math.min(1, k * 1.4));
        } else {
            // Straight down on the thrusters, slowing to a touch, blowing the dust about.
            const k = Math.min(1, (q.t - q.dur) / 4.5);
            const e = 1 - Math.pow(1 - k, 3);
            this.pilot.position.copy(hover.clone().lerp(q.pad, e));
            this.pilot.quaternion.copy(level);
            const h = this.pilot.position.y - q.pad.y;
            if (h < 45) this.foot.dust(q.pad.clone().setY(q.pad.y - 7.2), Math.ceil((1 - h / 45) * 6), 18);
            if (k >= 1) {
                this.mode = 'surface';
                this.game.park(true);
                this.foot.land(q.pad, q.yaw);
            }
        }
    }

    private takeOff() {
        const { pos, yaw } = this.foot.unpark();
        this.pilot.position.copy(pos);
        this.pilot.rotation.set(0, yaw, 0, 'YXZ');
        this.lastPos.copy(pos);
        this.game.park(false);
        this.mode = 'takeoff';
        this.seq = { t: 0, from: pos.clone(), fromQ: this.pilot.quaternion.clone(), pad: pos.clone(), yaw, dur: 3.5 };
        this.host.toast('Трап поднят. Взлёт!');
    }

    private takeoffStep(dt: number) {
        const q = this.seq;
        q.t += dt;
        const k = Math.min(1, q.t / q.dur);
        this.pilot.position.copy(q.from).setY(q.from.y + 90 * k * k);
        if (q.t < 1.5) this.foot.dust(q.from.clone().setY(q.from.y - 7.2), 5, 16);
        if (k >= 1) {
            this.mode = 'flight';
            this.ctl.enabled = true;
            this.ctl.sync();
            this.host.toast('Управление ваше. L — снова сесть');
        }
    }

    private leave() {
        if (this.leaving) return;
        this.leaving = true;
        this.host.back();
    }

    info(): string {
        const s = this.surface, v = this.visit, look = s.look;
        let html = row('Радиус', `${fmtNum(v.radiusKm)} км`);
        html += row('Ускорение свободного падения', `${fmtNum(v.gravity)} м/с²`);
        if (PRESSURE[v.name] !== undefined) html += row('Давление у поверхности', `${fmtNum(PRESSURE[v.name])} бар`);
        html += row('Высота над датумом', `${fmtNum(this.camera.position.y)} м`);
        html += row('Горизонт', `${fmtNum(Math.sqrt(2 * s.radiusM * Math.max(this.camera.position.y, 1)) / 1000)} км`);
        const elev = (Math.asin(this.sunDirection().y) * 180) / Math.PI;
        html += row('Высота Солнца', `${elev.toFixed(1)}°`);
        if (look.liquid) html += row('Моря', look.liquid.name);
        html += `<p><b>Из чего сделана поверхность.</b> ${look.note}</p>`;
        html += s.atmosphere
            ? `<p>Небо считается в реальном времени: рэлеевское рассеяние на молекулах (∝ λ⁻⁴ — поэтому небо Земли голубое)
               и рассеяние Ми на аэрозолях и пыли, с поглощением по пути к Солнцу — отсюда красные закаты.
               Дальние горы тонут в «воздушной перспективе». ${v.name === 'Марс' ? 'На Марсе пыль делает дневное небо рыжим, а вокруг заходящего Солнца — голубым.' : ''}
               ${look.clouds ? 'Облака — объём, через который идёт луч: у них светлые вершины, серые основания, светящиеся края против Солнца, и тени, которые плывут по земле.' : ''}</p>`
            : `<p>Атмосферы нет: небо чёрное даже днём, звёзды видны при Солнце, тени резкие, горизонт не размывается; пыль ярче всего в направлении от Солнца (эффект оппозиции).</p>`;
        html += `<p>Рельеф — фрактальный шум (fBm и «эрозионный» шум${s.craters ? ', плюс ударные кратеры с валами и лучами' : ''}), одна и та же функция на GPU и в коде столкновений.
            Поверхность изгибается вместе с планетой: на расстоянии d она опускается на d²/2R.
            ${look.flora ? 'Деревья и трава растут там, где шейдер рисует лес и луга, — по тому же шуму.' : ''}</p>`;
        return html;
    }

    status(): string {
        const hours = ((this.hourAngle / (2 * Math.PI)) * 24 + 12 + 24) % 24;
        const hh = Math.floor(hours), mm = Math.floor((hours - hh) * 60);
        const clock = `местное время ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        if (this.mode === 'surface') return `${this.foot.status()} · ${clock}`;
        if (this.mode === 'landing') return `Автопосадка · высота ${fmtNum(this.altitude())} м`;
        if (this.mode === 'takeoff') return 'Взлёт…';
        const alt = this.altitude();
        return `Скорость: ${fmtNum(this.speed)} м/с · над землёй ${fmtNum(alt)} м · ${clock} · газ ${fmtNum(this.ctl.speed)} м/с (колесо)${alt < LANDING_ALT ? ' · L — посадка' : ''}`;
    }

    update(dt: number) {
        this.time += dt;
        const secondsPerDay = Math.abs(this.visit.dayDays) * 86_400;
        this.hourAngle += ((2 * Math.PI) / secondsPerDay) * dt * this.daySpeed * Math.sign(this.visit.dayDays || 1);
        if (this.hourAngle > Math.PI) this.hourAngle -= 2 * Math.PI;
        if (this.hourAngle < -Math.PI) this.hourAngle += 2 * Math.PI;

        const p = this.pilot.position;
        if (this.mode === 'flight') {
            // Flight: fast when high, careful near the ground, never through it.
            const floor = Math.max(this.groundAt(p.x, p.z), this.surface.sea ?? -1e9);
            const alt = p.y - floor;
            const limit = Math.min(Math.max(40, alt * 2.5), this.game.speedLimit(p, this.ctl.boosted));
            this.speed = this.ctl.update(dt, limit);
            // The GPU adds finer octaves than the collision height; keep clear of them.
            const newFloor = Math.max(this.groundAt(p.x, p.z), this.surface.sea ?? -1e9) + 25;
            if (p.y < newFloor) p.y = newFloor;
            if (this.game.wantsFree) this.game.wantsFree = false;
        } else if (this.mode === 'landing') this.landingStep(dt);
        else if (this.mode === 'takeoff') this.takeoffStep(dt);
        this.velocity.subVectors(p, this.lastPos).divideScalar(Math.max(dt, 1e-4));
        this.lastPos.copy(p);

        // Light: sunlight through the air to here, and the sky's own glow as ambient light.
        const sun = this.sunDirection();
        const a = this.surface.atmosphere;
        const u = this.uniforms;
        u.uSunDir.value.copy(sun);
        u.uCamAlt.value = Math.max(this.camera.position.y, 0);
        const R = this.surface.radiusM;
        const eyeY = Math.max(this.camera.position.y, 0);
        if (a) {
            const t = sunTransmittance(a, eyeY / R, [sun.x, sun.y, sun.z]);
            this.sunColor.set(t[0], t[1], t[2]).multiplyScalar(a.sunIntensity * 0.08);
            const obs: [number, number, number] = [0, 1 + eyeY / R, 0];
            const zen = scatter(a, obs, [0, 1, 0], [sun.x, sun.y, sun.z], 12, 6);
            const away = new THREE.Vector3(-sun.x, 0.08, -sun.z).normalize();
            const hor = scatter(a, obs, [away.x, away.y, away.z], [sun.x, sun.y, sun.z], 12, 6);
            u.uZenith.value.set(...zen);
            u.uHorizon.value.set(...hor);
            // At night the sky still glows a little (airglow, starlight): enough to make out the land.
            u.uAmbient.value.set(Math.max(zen[0] * 0.9, 0.006), Math.max(zen[1] * 0.9, 0.008), Math.max(zen[2] * 0.9, 0.014));
        } else {
            const up = sun.y > -0.01 ? 1 : 0;
            this.sunColor.set(2.6, 2.55, 2.45).multiplyScalar(up);
            u.uZenith.value.set(0, 0, 0);
            u.uHorizon.value.set(0.01, 0.01, 0.012);
            // No sky to light the shadows, only sunlight thrown back by the ground around.
            const ga = this.surface.look.material.a;
            const bounce = up * Math.max(sun.y, 0) * 0.22;
            u.uAmbient.value.set(0.006 + ga[0] * bounce, 0.006 + ga[1] * bounce, 0.007 + ga[2] * bounce);
        }
        u.uSunColor.value.copy(this.sunColor);
        u.uTime.value = this.time;
        u.uWind.value.set(this.time * 9, this.time * 3);

        if (this.mode === 'surface') {
            this.ctl.enabled = false;
            this.foot.setCamera(this.camera);
            this.foot.update(dt, this.camera);
        }
        const lamp = this.foot.lamp();
        u.uLampPower.value = this.mode === 'surface' ? lamp.power : 0;
        u.uLampPos.value.copy(lamp.pos);
        u.uLampDir.value.copy(lamp.dir);
        this.game.update(dt, {
            pilot: this.pilot, camera: this.camera, free: this.mode !== 'surface', velocity: this.velocity.clone(),
            aim: this.mode === 'flight' ? this.ctl.aimQuaternion : this.pilot.quaternion, turnRate: this.mode === 'flight' ? this.ctl.turnRate : 0,
            pitchRate: this.mode === 'flight' ? this.ctl.pitchRate : 0, boost: this.ctl.boosted && this.mode === 'flight', strafe: this.mode === 'flight' ? this.ctl.strafe : 0,
            starPos: this.pilot.position.clone().addScaledVector(sun, 1e5), nearest: { name: this.visit.name, pos: new THREE.Vector3(), radius: 0 },
            width: this.width, height: this.height, now: this.time,
        });
        if (this.mode !== 'surface') this.foot.update(dt, this.camera);
        this.lightMeshes(sun, dt);
        // Keep the grids under the camera, snapped to their finest spacing so they do not swim.
        u.uOffset.value.set(Math.round(this.camera.position.x / NEAR_SPACING) * NEAR_SPACING, Math.round(this.camera.position.z / NEAR_SPACING) * NEAR_SPACING);
        this.sky.position.copy(this.camera.position);
        const camFloor = Math.max(this.groundAt(this.camera.position.x, this.camera.position.z), this.surface.sea ?? -1e9);
        this.scatterer.update(this.camera, this.camera.position.y - camFloor);

        if (this.mode === 'flight' && p.y > this.exitAltitude) {
            this.host.toast(`Выход на орбиту: ${this.visit.name}`);
            this.leave();
        }
    }

    /** How much of the Sun a point sees past the hills (0 in their shadow), like the ground shader's soft shadow. */
    private sunVisible(p: THREE.Vector3, L: THREE.Vector3): number {
        if (L.y <= -0.02) return 0;
        let res = 1, t = 3;
        for (let i = 0; i < 16; i++) {
            const x = p.x + L.x * t, y = p.y + 1 + L.y * t, z = p.z + L.z * t;
            const h = y - terrainHeight(this.terrain, x, z, 5);
            res = Math.min(res, (10 * h) / t);
            if (res < 0.001 || y > this.terrain.relief * 1.6) break;
            t *= 1.6;
        }
        return Math.min(1, Math.max(0, res));
    }

    private shade = 1;

    /** Sunlight and skylight for the meshes (ship, robot, beings), and sky reflections in their metal. */
    private lightMeshes(sun: THREE.Vector3, dt: number) {
        const { sun: light, fill } = this.game.lights;
        const c = this.sunColor;
        const peak = Math.max(c.x, c.y, c.z, 1e-4);
        const focus = this.mode === 'surface' ? this.foot.focus : this.pilot.position;
        // In a hill's shadow the robot (and whatever stands near it) is in shadow too.
        this.shade += (this.sunVisible(focus, sun) - this.shade) * (1 - Math.exp(-4 * dt));
        light.color.setRGB(c.x / peak, c.y / peak, c.z / peak);
        light.intensity = peak * 1.25 * this.shade;
        light.position.copy(focus).addScaledVector(sun, 500);
        light.target.position.copy(focus);
        light.target.updateMatrixWorld();
        const amb = this.uniforms.uAmbient.value as THREE.Vector3;
        const ambPeak = Math.max(amb.x, amb.y, amb.z, 1e-4);
        fill.color.setRGB(amb.x / ambPeak, amb.y / ambPeak, amb.z / ambPeak);
        const ga = this.surface.look.material.a;
        fill.groundColor.setRGB(ga[0], ga[1], ga[2]).multiplyScalar(Math.max(0.2, Math.min(1, peak)));
        fill.intensity = Math.min(1.6, ambPeak * 3) + 0.06;
        this.foot.sunShare = Math.min(1, Math.max(0, sun.y * 6)) * Math.min(1, peak) * this.shade;
        // The environment map, from the same sky, now and then.
        this.envClock -= dt;
        if (this.envClock <= 0) {
            this.envClock = 4;
            const m = this.envSky.material as THREE.ShaderMaterial;
            const z = this.uniforms.uZenith.value as THREE.Vector3, h = this.uniforms.uHorizon.value as THREE.Vector3;
            m.uniforms.uTop.value.setRGB(z.x, z.y, z.z).multiplyScalar(1.2).addScalar(0.01);
            m.uniforms.uMid.value.setRGB(h.x, h.y, h.z).multiplyScalar(1.1).addScalar(0.012);
            m.uniforms.uLow.value.setRGB(ga[0], ga[1], ga[2]).multiplyScalar(0.15 + 0.5 * Math.min(1, peak));
            m.uniforms.uSun.value.copy(sun);
            m.uniforms.uSunCol.value.setRGB(c.x, c.y, c.z);
            const rt = this.pmrem.fromScene(this.envScene, 0.02);
            this.envRT?.dispose();
            this.envRT = rt;
            this.scene.environment = rt.texture;
        }
    }

    // -----------------------------------------------------------------------
    // Saving.
    // -----------------------------------------------------------------------

    saveState(): CameraState | null {
        const hour = this.hourAngle;
        const f = this.mode === 'surface' ? this.foot.saveState() : null;
        if (f) {
            return {
                position: this.camera.position.toArray(), quaternion: this.camera.quaternion.toArray(),
                data: { mode: 'surface', sx: f.ship[0], sy: f.ship[1], sz: f.ship[2], syaw: f.ship[3], rx: f.robot[0], ry: f.robot[1], rz: f.robot[2], cam: f.camYaw, hour },
            };
        }
        return { position: this.pilot.position.toArray(), quaternion: this.pilot.quaternion.toArray(), data: { hour } };
    }

    resumed(state: CameraState) {
        const d = state.data ?? {};
        if (typeof d.hour === 'number') this.hourAngle = d.hour;
        if (d.mode === 'surface') {
            this.mode = 'surface';
            this.ctl.enabled = false;
            this.game.park(true);
            this.pilot.position.set(Number(d.sx), Number(d.sy), Number(d.sz));
            this.foot.restore({ ship: [Number(d.sx), Number(d.sy), Number(d.sz), Number(d.syaw)], robot: [Number(d.rx), Number(d.ry), Number(d.rz)], camYaw: Number(d.cam) });
            return;
        }
        this.pilot.position.copy(this.camera.position);
        this.pilot.quaternion.copy(this.camera.quaternion);
        this.lastPos.copy(this.pilot.position);
        this.ctl.sync();
    }

    resize(w: number, h: number) {
        this.width = w; this.height = h;
        for (const c of [this.camera, this.pilot]) { c.aspect = w / h; c.updateProjectionMatrix(); }
    }

    dispose() {
        window.removeEventListener('keydown', this.onKey);
        this.ctl.dispose();
        this.foot.dispose();
        this.scatterer.dispose();
        this.game.dispose();
        this.envRT?.dispose();
        this.pmrem.dispose();
        this.scene.environment = null;
        this.scene.traverse(o => {
            const m = o as THREE.Mesh;
            m.geometry?.dispose();
            const mat = m.material as THREE.Material | undefined;
            mat?.dispose?.();
        });
    }
}
