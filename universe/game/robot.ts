// The pilot's robot: a sleek, futuristic android about 1.9 m tall — lacquered
// shell panels in the ship's colours over dark carbon joints, glowing seams, an
// egg-shaped helmet with a wide visor, floating shoulder plates, a slim jet
// pack with fins, a blaster in the right hand.
//
// It moves like a person. The feet are placed by two-bone inverse kinematics
// along a stance-and-swing path matched to the ground speed, so they do not
// slide; the pelvis bobs twice a stride and sways over the standing leg, the
// shoulders counter-rotate, the arms swing and flex, the body leans into
// acceleration and banks into turns, and every joint follows its target
// through a critically damped spring, so nothing snaps. It lopes in low
// gravity, crouches before a jump, tucks in the air, absorbs the landing,
// flinches when hit, sits at the wheel of the rover and collapses when
// destroyed. Metres; the model faces −Z.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ShipLook } from './progress';

const rbox = (w: number, h: number, d: number, r = 0.03) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));
const sphere = (r: number, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 6, 16);
const cyl = (r1: number, r2: number, h: number, seg = 18) => new THREE.CylinderGeometry(r1, r2, h, seg);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    return m;
}
const group = (x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); return g; };

export interface RobotPose {
    /** Ground speed, m/s. */
    speed: number;
    /** Standing on the ground (not in the air). */
    grounded: boolean;
    /** The jet pack is firing. */
    jets: boolean;
    /** Holding the blaster up, and at what pitch (rad, + up). */
    aiming: boolean;
    aimPitch: number;
    /** Gravity, m/s²: below ~3 the gait turns into the loping hop of the Apollo astronauts. */
    gravity: number;
    /** Sitting at the wheel of the rover, and which way it steers (−1…1). */
    seated?: boolean;
    steer?: number;
    /** Heading, rad: its rate of change banks the body into turns. */
    yaw?: number;
}

/** A critically damped spring towards a target: smooth, no overshoot, no snapping. */
class Spring {
    v = 0;
    constructor(public x = 0, private k = 14) {}
    to(target: number, dt: number, k = this.k): number {
        const w = k, a = w * w * (target - this.x) - 2 * w * this.v;
        this.v += a * dt;
        this.x += this.v * dt;
        return this.x;
    }
}

const THIGH = 0.44, SHIN = 0.43, ANKLE_H = 0.085, HIP_H = 0.97;

export class Robot {
    readonly root = new THREE.Group();
    /** Where bolts leave the blaster. */
    readonly muzzle = new THREE.Object3D();
    readonly headlamp = new THREE.SpotLight(0xfff2dd, 0, 60, 0.5, 0.45, 1.2);
    private pelvis = group(0, HIP_H, 0);
    private spine = group(0, 0.12, 0);
    private chest = group(0, 0.22, 0);
    private neck = group(0, 0.5, 0);
    private head = group(0, 0.08, 0);
    private legs: { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group }[] = [];
    private arms: { shoulder: THREE.Group; elbow: THREE.Group; wrist: THREE.Group }[] = [];
    private flames: THREE.Mesh[] = [];
    private beacon: THREE.Mesh;
    private glowMats: THREE.MeshStandardMaterial[] = [];
    private shell: THREE.MeshPhysicalMaterial;
    private s: Record<string, Spring> = {};
    private phase = 0;
    private time = 0;
    private hurt = 0;
    private wasGrounded = true;
    private landing = new Spring(0, 9);
    private lastYaw: number | null = null;
    private lastSpeed = 0;
    private down = 0;

    constructor(look: ShipLook) {
        const hull = new THREE.Color(look.hull), accent = new THREE.Color(look.accent), glowCol = new THREE.Color(look.glow);
        this.shell = new THREE.MeshPhysicalMaterial({ color: hull, metalness: 0.25, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08 });
        const trimMat = new THREE.MeshPhysicalMaterial({ color: accent, metalness: 0.5, roughness: 0.3, clearcoat: 0.6 });
        const carbon = new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.7, roughness: 0.32 });
        const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.1, roughness: 0.85 });
        const glow = (k = 2.4) => {
            const m = new THREE.MeshStandardMaterial({ color: 0x040506, emissive: glowCol, emissiveIntensity: k, metalness: 0.2, roughness: 0.25 });
            this.glowMats.push(m);
            return m;
        };
        const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x05070a, metalness: 0.9, roughness: 0.04, clearcoat: 1, emissive: glowCol, emissiveIntensity: 0.35 });

        this.root.add(this.pelvis);
        // Pelvis: a carbon hip block under a lacquered belt plate.
        this.pelvis.add(mesh(capsule(0.1, 0.2), carbon, 0, 0, 0, 1, 1, 1).rotateZ(Math.PI / 2));
        this.pelvis.add(mesh(rbox(0.36, 0.1, 0.22, 0.05), this.shell, 0, 0.06, 0));
        this.pelvis.add(mesh(new THREE.TorusGeometry(0.13, 0.012, 8, 32), glow(1.6), 0, 0.13, 0).rotateX(Math.PI / 2));

        // Spine: a slim waist, then a V-shaped chest.
        this.pelvis.add(this.spine);
        this.spine.add(mesh(cyl(0.1, 0.13, 0.2, 20), carbon, 0, 0.05, 0));
        this.spine.add(this.chest);
        this.chest.add(mesh(sphere(0.3), this.shell, 0, 0.2, 0, 1.2, 1.05, 0.72));
        this.chest.add(mesh(rbox(0.34, 0.22, 0.08, 0.04), trimMat, 0, 0.24, -0.17));
        // The chest emblem: a glowing core in a ring.
        this.chest.add(mesh(sphere(0.045, 16, 12), glow(3.5), 0, 0.24, -0.215));
        this.chest.add(mesh(new THREE.TorusGeometry(0.07, 0.01, 8, 32), glow(2), 0, 0.24, -0.215));
        // Seams: glowing lines down the flanks and across the collar.
        for (const s of [-1, 1]) this.chest.add(mesh(capsule(0.008, 0.26), glow(1.4), s * 0.29, 0.18, -0.08).rotateZ(s * 0.25));
        this.chest.add(mesh(capsule(0.008, 0.3), glow(1.4), 0, 0.42, -0.12).rotateZ(Math.PI / 2));
        // Jet pack: slim, with two thrusters and swept fins.
        const pack = group(0, 0.2, 0.2);
        this.chest.add(pack);
        pack.add(mesh(rbox(0.32, 0.4, 0.12, 0.06), trimMat));
        for (const s of [-1, 1]) {
            pack.add(mesh(capsule(0.05, 0.28), this.shell, s * 0.1, -0.02, 0.08));
            pack.add(mesh(cyl(0.035, 0.06, 0.1), carbon, s * 0.1, -0.26, 0.08));
            const fin = mesh(rbox(0.2, 0.3, 0.02, 0.01), this.shell, s * 0.22, 0.06, 0.05);
            fin.rotation.set(0.2, s * 0.5, s * -0.5);
            pack.add(fin);
            pack.add(mesh(capsule(0.006, 0.2), glow(1.8), s * 0.26, 0.06, 0.06).rotateZ(s * -0.5));
            const flameMat = new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(2.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
            const flame = mesh(new THREE.ConeGeometry(0.05, 0.6, 12, 1, true), flameMat, s * 0.1, -0.6, 0.08);
            flame.rotation.x = Math.PI;
            flame.visible = false;
            pack.add(flame);
            this.flames.push(flame);
        }
        // Neck and helmet: an egg with a wide visor band and small fins.
        this.chest.add(this.neck);
        this.neck.add(mesh(cyl(0.05, 0.065, 0.1, 16), carbon));
        this.neck.add(this.head);
        this.head.add(mesh(sphere(0.15, 28, 20), this.shell, 0, 0.12, 0.01, 1, 1.12, 1.1));
        this.head.add(mesh(new THREE.SphereGeometry(0.152, 32, 12, Math.PI * 0.55, Math.PI * 0.9, Math.PI * 0.38, Math.PI * 0.22), visorMat, 0, 0.12, 0.012, 1, 1.12, 1.1));
        this.head.add(mesh(capsule(0.006, 0.2), glow(3), 0, 0.12, -0.163).rotateZ(Math.PI / 2));
        for (const s of [-1, 1]) {
            const fin = mesh(rbox(0.02, 0.1, 0.12, 0.01), trimMat, s * 0.15, 0.16, 0.05);
            fin.rotation.x = -0.3;
            this.head.add(fin);
        }
        this.head.add(mesh(cyl(0.006, 0.006, 0.22, 6), carbon, 0.07, 0.36, 0.06));
        this.beacon = mesh(sphere(0.018, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3030 }), 0.07, 0.48, 0.06);
        this.head.add(this.beacon);
        this.headlamp.position.set(0, 0.12, -0.16);
        this.headlamp.target.position.set(0, -0.6, -6);
        this.head.add(this.headlamp, this.headlamp.target);

        // Arms: a carbon ball joint under a floating shoulder plate, sculpted upper arm and forearm.
        for (const s of [-1, 1]) {
            const shoulder = group(s * 0.33, 0.34, 0);
            this.chest.add(shoulder);
            shoulder.add(mesh(sphere(0.07), carbon));
            const plate = mesh(new THREE.SphereGeometry(0.13, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), this.shell, s * 0.03, 0.03, 0, 1, 0.9, 1.1);
            plate.rotation.z = -s * 0.35;
            shoulder.add(plate);
            shoulder.add(mesh(capsule(0.006, 0.14), glow(1.6), s * 0.1, 0.02, 0).rotateX(Math.PI / 2));
            shoulder.add(mesh(capsule(0.058, 0.2), this.shell, 0, -0.16, 0));
            const elbow = group(0, -0.3, 0);
            shoulder.add(elbow);
            elbow.add(mesh(sphere(0.05), carbon));
            elbow.add(mesh(capsule(0.05, 0.18), this.shell, 0, -0.13, 0, 1.05, 1, 1.05));
            elbow.add(mesh(cyl(0.056, 0.05, 0.07, 18), trimMat, 0, -0.22, 0));
            const wrist = group(0, -0.28, 0);
            elbow.add(wrist);
            wrist.add(mesh(rbox(0.07, 0.09, 0.1, 0.025), carbon, 0, -0.04, 0));
            for (let f = 0; f < 3; f++) wrist.add(mesh(capsule(0.011, 0.05), carbon, -0.022 + f * 0.022, -0.1, -0.03));
            wrist.add(mesh(capsule(0.012, 0.035), carbon, s * 0.04, -0.07, -0.03));
            this.arms.push({ shoulder, elbow, wrist });
            if (s > 0) {
                // The blaster: a sleek body, a glowing cell, a barrel with cooling rings.
                const gun = group(0, -0.07, -0.08);
                wrist.add(gun);
                gun.add(mesh(rbox(0.06, 0.09, 0.32, 0.03), carbon, 0, 0, -0.08));
                gun.add(mesh(rbox(0.065, 0.045, 0.16, 0.02), this.shell, 0, 0.055, -0.06));
                gun.add(mesh(rbox(0.02, 0.02, 0.12, 0.008), glow(2.6), 0, 0.03, -0.1));
                const barrel = mesh(cyl(0.02, 0.024, 0.2, 14), trimMat, 0, 0.012, -0.32);
                barrel.rotation.x = Math.PI / 2;
                gun.add(barrel);
                for (let k = 0; k < 3; k++) gun.add(mesh(new THREE.TorusGeometry(0.03, 0.006, 6, 20), glow(1.5), 0, 0.012, -0.26 - k * 0.045));
                this.muzzle.position.set(0, 0.012, -0.44);
                gun.add(this.muzzle);
            }
        }

        // Legs: sculpted thigh with a glowing seam, a knee guard, a tapered shin, a sleek foot.
        for (const s of [-1, 1]) {
            const hip = group(s * 0.13, -0.04, 0);
            this.pelvis.add(hip);
            hip.add(mesh(sphere(0.075), carbon));
            hip.add(mesh(capsule(0.078, THIGH - 0.14), this.shell, 0, -THIGH / 2, 0, 1, 1, 1.05));
            hip.add(mesh(capsule(0.007, 0.24), glow(1.3), s * 0.075, -THIGH / 2, -0.02));
            const knee = group(0, -THIGH, 0);
            hip.add(knee);
            knee.add(mesh(sphere(0.06), carbon));
            knee.add(mesh(new THREE.SphereGeometry(0.075, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), trimMat, 0, 0.01, -0.035).rotateX(-Math.PI / 2));
            knee.add(mesh(cyl(0.07, 0.05, SHIN - 0.1, 20), this.shell, 0, -SHIN / 2, 0.005));
            knee.add(mesh(capsule(0.006, 0.2), glow(1.2), 0, -SHIN / 2, -0.066));
            const ankle = group(0, -SHIN, 0);
            knee.add(ankle);
            ankle.add(mesh(sphere(0.045), carbon));
            ankle.add(mesh(rbox(0.11, 0.07, 0.26, 0.03), this.shell, 0, -0.035, -0.05));
            ankle.add(mesh(rbox(0.115, 0.018, 0.27, 0.008), rubber, 0, -0.075, -0.05));
            ankle.add(mesh(rbox(0.1, 0.01, 0.2, 0.004), glow(1.4), 0, -0.064, -0.05));
            this.legs.push({ hip, knee, ankle });
        }
        this.root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
    }

    /** Height of the eyes above the feet, m. */
    static readonly EYE = 1.85;

    /** Knocked back by a hit: a flinch and a red flash. */
    flinch() { this.hurt = 1; }

    /** Collapsed (destroyed) 0…1. */
    set collapsed(v: number) { this.down = v; }

    private spring(name: string, k = 14): Spring {
        return (this.s[name] ??= new Spring(0, k));
    }

    /** Two-bone IK in the leg's plane: hip and knee angles putting the ankle at (forward, down) from the hip. */
    private solveLeg(forward: number, down: number): [number, number] {
        const d = Math.min(Math.hypot(forward, down), THIGH + SHIN - 1e-3);
        const cosKnee = (THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN);
        const bend = Math.PI - Math.acos(THREE.MathUtils.clamp(cosKnee, -1, 1));
        const base = Math.atan2(forward, down);
        const cosA = (THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d);
        const alpha = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
        // Forward swing is a negative rotation about x; the knee folds backwards (positive).
        return [-(base + alpha), bend];
    }

    update(dt: number, pose: RobotPose) {
        this.time += dt;
        dt = Math.min(dt, 0.05);
        const lowG = pose.gravity < 3;
        // Smoothed speed and acceleration drive everything, so starts and stops blend.
        const speed = this.spring('speed', 6).to(pose.speed, dt);
        const accel = (speed - this.lastSpeed) / Math.max(dt, 1e-3);
        this.lastSpeed = speed;
        let turn = 0;
        if (pose.yaw !== undefined) {
            if (this.lastYaw !== null) turn = Math.atan2(Math.sin(pose.yaw - this.lastYaw), Math.cos(pose.yaw - this.lastYaw)) / Math.max(dt, 1e-3);
            this.lastYaw = pose.yaw;
        }
        const run = THREE.MathUtils.smoothstep(speed, 3.5, 7.5);
        const moving = THREE.MathUtils.smoothstep(speed, 0.05, 0.6);
        // Cadence (strides per second) and how much of a stride a foot spends on the ground.
        const cadence = lowG ? 0.75 : 0.85 + speed * 0.13;
        const stance = lowG ? 0.35 : THREE.MathUtils.lerp(0.62, 0.38, run);
        if (pose.grounded) this.phase = (this.phase + cadence * dt * moving) % 1;
        // A foot on the ground moves back at exactly the ground speed: no sliding.
        const reach = (speed * stance) / cadence;
        if (pose.grounded && !this.wasGrounded) this.landing.v = -3.5;
        this.wasGrounded = pose.grounded;
        const land = this.landing.to(0, dt);
        this.hurt = Math.max(0, this.hurt - dt * 4);

        // Pelvis: bobs twice a stride (lowest when the legs are spread), sways over the standing leg.
        const bob = pose.grounded ? (lowG ? Math.sin(this.phase * Math.PI * 2) * 0.05 : -Math.cos(this.phase * Math.PI * 4) * (0.02 + run * 0.03)) * moving : 0;
        const crouch = pose.grounded ? 0.02 * moving + run * 0.05 : 0;
        const hipY = HIP_H - crouch + bob + land * 0.12;
        const sway = Math.sin(this.phase * Math.PI * 2) * 0.03 * moving * (1 - run) * (lowG ? 0 : 1);

        const seated = !!pose.seated;
        for (let i = 0; i < 2; i++) {
            const leg = this.legs[i];
            const ph = (this.phase + (lowG ? i * 0.12 : i * 0.5)) % 1;
            let hip: number, knee: number, ankle: number;
            if (seated) {
                hip = -1.45; knee = 1.45; ankle = -0.1;
            } else if (!pose.grounded) {
                // In the air: knees drawn up, one leg a little ahead; hanging when falling.
                hip = -0.55 + i * 0.3; knee = 0.95 - i * 0.25; ankle = 0.25;
            } else {
                let fwd: number, lift: number;
                if (ph < stance) { fwd = reach / 2 - (ph / stance) * reach; lift = 0; }
                else {
                    const u = (ph - stance) / (1 - stance);
                    const e = u * u * (3 - 2 * u);
                    fwd = -reach / 2 + e * reach;
                    lift = Math.sin(u * Math.PI) * (0.08 + run * 0.14 + (lowG ? 0.1 : 0)) * moving;
                }
                const down = hipY - 0.04 - ANKLE_H - lift - Math.max(0, land) * 0.1;
                [hip, knee] = this.solveLeg(fwd * moving, down);
                // The foot stays level on the ground, rolls onto the toe as it pushes off.
                const toeOff = ph > stance - 0.1 && ph < stance + 0.1 ? Math.sin(((ph - stance + 0.1) / 0.2) * Math.PI) * 0.35 * moving : 0;
                ankle = -(hip + knee) + toeOff;
            }
            leg.hip.rotation.x = this.spring(`hip${i}`, seated || !pose.grounded ? 10 : 30).to(hip, dt);
            leg.knee.rotation.x = this.spring(`knee${i}`, seated || !pose.grounded ? 10 : 30).to(knee, dt);
            leg.ankle.rotation.x = this.spring(`ankle${i}`, 30).to(ankle, dt);
            leg.hip.rotation.z = (i ? -1 : 1) * (0.02 + sway * 0.4);
        }
        this.pelvis.position.y = seated ? 0.5 : this.spring('hipY', 18).to(hipY, dt);
        this.pelvis.position.x = this.spring('sway', 10).to(sway, dt);
        this.pelvis.rotation.y = this.spring('pelvisTwist', 10).to(Math.sin(this.phase * Math.PI * 2) * 0.12 * moving, dt);
        this.pelvis.rotation.z = this.spring('pelvisTilt', 10).to(-sway * 2, dt);

        // Upper body: leans into speed and acceleration, banks into turns, counter-twists the hips.
        const lean = -0.06 * moving - run * 0.16 - THREE.MathUtils.clamp(accel * 0.02, -0.15, 0.15) + this.hurt * 0.3 + (seated ? 0.1 : 0);
        this.spine.rotation.x = this.spring('lean', 8).to(lean, dt);
        this.spine.rotation.z = this.spring('bank', 6).to(THREE.MathUtils.clamp(turn * 0.08 * moving, -0.2, 0.2) + (seated ? -(pose.steer ?? 0) * 0.08 : 0), dt);
        this.spine.rotation.y = this.spring('twist', 10).to(pose.aiming ? 0 : -this.pelvis.rotation.y * 1.4, dt);
        const breathe = 1 + Math.sin(this.time * 1.7) * 0.012 * (1 - moving);
        this.chest.scale.set(breathe, 1, breathe);

        // Arms: counter-swing with the legs, elbows bending more as it runs; the right one aims.
        const aim = this.spring('aim', 12).to(pose.aiming ? 1 : 0, dt);
        for (let i = 0; i < 2; i++) {
            const arm = this.arms[i];
            const ph = (this.phase + (lowG ? i * 0.12 : i * 0.5) + 0.5) % 1;
            const swing = Math.sin(ph * Math.PI * 2) * (0.35 + run * 0.4) * moving * (lowG ? 0.4 : 1);
            let sh = -swing * 0.9, el = -0.15 - (0.25 + run * 1.0) * moving - Math.max(0, swing) * 0.3;
            let side = (i ? -1 : 1) * 0.1;
            if (!pose.grounded && !seated) { sh = -0.5; el = -0.7; side = (i ? -1 : 1) * 0.45; }
            if (seated) {
                // Hands on the wheel, turning it.
                sh = -1.05; el = -0.75; side = (i ? -1 : 1) * 0.05 + (pose.steer ?? 0) * 0.15 * (i ? 1 : -1);
            } else if (i === 1) {
                sh = THREE.MathUtils.lerp(sh, -Math.PI / 2 - pose.aimPitch, aim);
                el = THREE.MathUtils.lerp(el, -0.05, aim);
                side = THREE.MathUtils.lerp(side, 0.05, aim);
            } else {
                sh = THREE.MathUtils.lerp(sh, -1.1 - pose.aimPitch * 0.8, aim * 0.8);
                el = THREE.MathUtils.lerp(el, -0.95, aim * 0.8);
                side = THREE.MathUtils.lerp(side, 0.5, aim * 0.8);
            }
            arm.shoulder.rotation.x = this.spring(`sh${i}`, 16).to(sh, dt);
            arm.shoulder.rotation.z = this.spring(`side${i}`, 14).to(side, dt);
            arm.elbow.rotation.x = this.spring(`el${i}`, 16).to(el, dt);
            arm.wrist.rotation.x = this.spring(`wr${i}`, 12).to(moving * -0.15, dt);
        }
        // Head: steady against the bob, follows the aim, looks around when idle.
        const idle = 1 - moving;
        this.head.rotation.y = this.spring('headY', 5).to((Math.sin(this.time * 0.37) * 0.4 + Math.sin(this.time * 0.13) * 0.2) * idle * (1 - aim) - this.spine.rotation.y * 0.8, dt);
        this.head.rotation.x = this.spring('headX', 6).to(-pose.aimPitch * 0.5 * aim + Math.sin(this.time * 0.23) * 0.08 * idle - this.spine.rotation.x * 0.7, dt);

        // Jets, lights, damage.
        const flicker = 0.8 + 0.2 * Math.sin(this.time * 53) * Math.sin(this.time * 37);
        for (const f of this.flames) { f.visible = pose.jets; f.scale.set(1, flicker, 1); }
        (this.beacon.material as THREE.MeshBasicMaterial).color.setHex(Math.sin(this.time * 4) > 0.6 ? 0xff4040 : 0x300808);
        const pulse = 2.2 + Math.sin(this.time * 2.2) * 0.4;
        for (const m of this.glowMats) m.emissiveIntensity = pulse * (this.down > 0 ? 1 - this.down : 1);
        this.shell.emissive.setRGB(this.hurt * 0.9, this.hurt * 0.1, 0);
        if (this.down > 0) {
            const d = this.down;
            for (const leg of this.legs) { leg.knee.rotation.x = 1.6 * d; leg.hip.rotation.x = -1.2 * d; }
            this.pelvis.position.y = HIP_H * (1 - d * 0.7);
            this.spine.rotation.x = 0.9 * d;
            this.head.rotation.x = 0.5 * d;
        }
    }

    dispose() {
        this.root.traverse(o => {
            const m = o as THREE.Mesh;
            if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
        });
    }
}
