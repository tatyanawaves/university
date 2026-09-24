// The pilot's robot, who walks out of the ship onto a planet: about 2 m tall,
// jointed like a person (hips, knees, ankles, shoulders, elbows), armoured in
// the ship's colours, with a glowing visor, a chest core, a jet pack and a
// blaster. It walks, runs, hops in low gravity, jumps, flies on its jets,
// aims, flinches when hit and collapses when destroyed. Sizes are in metres;
// the model faces −Z, like a camera.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ShipLook } from './progress';

const box = (w: number, h: number, d: number, r = 0.03) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2));
const cyl = (r1: number, r2: number, h: number, seg = 14) => new THREE.CylinderGeometry(r1, r2, h, seg);
const sphere = (r: number, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h);
const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 12);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
}

function group(x = 0, y = 0, z = 0): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    return g;
}

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
}

export class Robot {
    readonly root = new THREE.Group();
    /** Where bolts leave the blaster. */
    readonly muzzle = new THREE.Object3D();
    readonly headlamp = new THREE.SpotLight(0xfff2dd, 0, 60, 0.5, 0.45, 1.2);
    private hips = group(0, 0.98, 0);
    private torso = group(0, 0.1, 0);
    private head = group(0, 0.8, 0);
    private legs: { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group }[] = [];
    private arms: { shoulder: THREE.Group; elbow: THREE.Group; hand: THREE.Group }[] = [];
    private flames: THREE.Mesh[] = [];
    private beacon: THREE.Mesh;
    private glowMats: THREE.MeshStandardMaterial[] = [];
    private skin: THREE.MeshStandardMaterial;
    private phase = 0;
    private time = 0;
    private landing = 0;
    private hurt = 0;
    private wasGrounded = true;
    private aimBlend = 0;
    private down = 0;

    constructor(look: ShipLook) {
        const hullCol = new THREE.Color(look.hull), accentCol = new THREE.Color(look.accent), glowCol = new THREE.Color(look.glow);
        this.skin = new THREE.MeshStandardMaterial({ color: hullCol, metalness: 0.55, roughness: 0.38 });
        const plate = new THREE.MeshStandardMaterial({ color: hullCol.clone().multiplyScalar(0.82), metalness: 0.6, roughness: 0.45 });
        const frame = new THREE.MeshStandardMaterial({ color: accentCol, metalness: 0.75, roughness: 0.5 });
        const joint = new THREE.MeshStandardMaterial({ color: 0x1b1e24, metalness: 0.85, roughness: 0.35 });
        const rubber = new THREE.MeshStandardMaterial({ color: 0x0e0f12, metalness: 0.1, roughness: 0.9 });
        const glow = (k = 2.2) => {
            const m = new THREE.MeshStandardMaterial({ color: 0x050608, emissive: glowCol, emissiveIntensity: k, metalness: 0.2, roughness: 0.2 });
            this.glowMats.push(m);
            return m;
        };
        const visorMat = new THREE.MeshStandardMaterial({ color: 0x0a0d12, emissive: glowCol, emissiveIntensity: 1.2, metalness: 0.9, roughness: 0.05 });
        this.glowMats.push(visorMat);

        this.root.add(this.hips);
        // Pelvis: a hip block with the belt and joint housings.
        this.hips.add(mesh(box(0.36, 0.18, 0.24, 0.05), frame, 0, 0, 0));
        this.hips.add(mesh(box(0.4, 0.06, 0.27, 0.02), plate, 0, 0.1, 0));
        for (const s of [-1, 1]) this.hips.add(mesh(sphere(0.085), joint, s * 0.17, -0.04, 0));

        // Torso: waist segments, the chest shell, the core, the jet pack.
        this.hips.add(this.torso);
        for (let i = 0; i < 3; i++) this.torso.add(mesh(cyl(0.14 + i * 0.012, 0.15 + i * 0.012, 0.07), i % 2 ? frame : joint, 0, 0.06 + i * 0.075, 0));
        const chest = mesh(box(0.6, 0.5, 0.36, 0.09), this.skin, 0, 0.47, 0);
        this.torso.add(chest);
        this.torso.add(mesh(box(0.5, 0.2, 0.06, 0.03), plate, 0, 0.56, -0.17));   // chest plate
        this.torso.add(mesh(box(0.46, 0.12, 0.05, 0.02), plate, 0, 0.3, -0.17));   // belly plate
        const core = mesh(cyl(0.065, 0.065, 0.03, 20), glow(3), 0, 0.46, -0.2);
        core.rotation.x = Math.PI / 2;
        this.torso.add(core);
        this.torso.add(mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 24), joint, 0, 0.46, -0.205));
        // Vents and a stripe on the chest.
        for (let i = 0; i < 3; i++) this.torso.add(mesh(box(0.1, 0.012, 0.02, 0.004), joint, 0.18, 0.62 - i * 0.03, -0.205));
        for (const s of [-1, 1]) this.torso.add(mesh(box(0.02, 0.36, 0.02, 0.008), glow(1.2), s * 0.285, 0.47, -0.12));
        // Jet pack.
        const pack = group(0, 0.46, 0.25);
        this.torso.add(pack);
        pack.add(mesh(box(0.44, 0.46, 0.16, 0.05), frame));
        pack.add(mesh(box(0.34, 0.1, 0.03, 0.02), plate, 0, 0.12, 0.085));
        for (const s of [-1, 1]) {
            const tank = mesh(capsule(0.065, 0.3), plate, s * 0.15, 0, 0.1);
            pack.add(tank);
            const nozzle = mesh(cyl(0.05, 0.08, 0.12), joint, s * 0.12, -0.28, 0.06);
            pack.add(nozzle);
            const flameMat = new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(2.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
            const flame = mesh(new THREE.ConeGeometry(0.07, 0.6, 12, 1, true), flameMat, s * 0.12, -0.64, 0.06);
            flame.rotation.x = Math.PI;
            flame.visible = false;
            pack.add(flame);
            this.flames.push(flame);
        }
        // Neck and head: a rounded helmet, a wraparound visor, cheek guards, an antenna with a beacon.
        this.torso.add(mesh(cyl(0.07, 0.09, 0.12), joint, 0, 0.76, 0));
        this.torso.add(this.head);
        this.head.add(mesh(box(0.3, 0.28, 0.3, 0.1), this.skin, 0, 0.12, 0));
        this.head.add(mesh(box(0.32, 0.06, 0.28, 0.03), plate, 0, 0.25, 0.01));
        const visor = mesh(new THREE.SphereGeometry(0.16, 24, 12, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.36, Math.PI * 0.26), visorMat, 0, 0.13, 0.005);
        this.head.add(visor);
        for (const s of [-1, 1]) {
            const ear = mesh(cyl(0.06, 0.06, 0.05, 16), frame, s * 0.16, 0.11, 0.02);
            ear.rotation.z = Math.PI / 2;
            this.head.add(ear);
            this.head.add(mesh(cyl(0.025, 0.025, 0.055, 12), glow(1.5), s * 0.186, 0.11, 0.02).rotateZ(Math.PI / 2));
        }
        this.head.add(mesh(cyl(0.008, 0.008, 0.28, 6), joint, 0.1, 0.36, 0.08));
        this.beacon = mesh(sphere(0.022, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3030 }), 0.1, 0.5, 0.08);
        this.head.add(this.beacon);
        // The head lamp shines where the head looks.
        this.headlamp.position.set(0, 0.16, -0.14);
        this.headlamp.target.position.set(0, -0.6, -6);
        this.head.add(this.headlamp, this.headlamp.target);
        this.head.add(mesh(cyl(0.03, 0.035, 0.03, 12), glow(2.5), 0.12, 0.2, -0.14).rotateX(Math.PI / 2));

        // Arms: pauldron, upper arm, elbow, forearm with a gauntlet, hand; the right one holds the blaster.
        for (const s of [-1, 1]) {
            const shoulder = group(s * 0.38, 0.62, 0);
            this.torso.add(shoulder);
            shoulder.add(mesh(sphere(0.085), joint));
            const pad = mesh(box(0.2, 0.12, 0.24, 0.06), this.skin, s * 0.03, 0.07, 0);
            pad.rotation.z = -s * 0.25;
            shoulder.add(pad);
            shoulder.add(mesh(box(0.012, 0.04, 0.2, 0.005), glow(1.4), s * 0.12, 0.05, 0).rotateZ(-s * 0.25));
            shoulder.add(mesh(capsule(0.06, 0.2), frame, 0, -0.16, 0));
            shoulder.add(mesh(box(0.13, 0.16, 0.14, 0.04), plate, s * 0.01, -0.14, 0));
            const elbow = group(0, -0.33, 0);
            shoulder.add(elbow);
            elbow.add(mesh(sphere(0.06), joint));
            elbow.add(mesh(box(0.13, 0.26, 0.13, 0.05), this.skin, 0, -0.15, 0));
            elbow.add(mesh(box(0.145, 0.06, 0.145, 0.02), plate, 0, -0.25, 0));
            const hand = group(0, -0.32, 0);
            elbow.add(hand);
            hand.add(mesh(box(0.09, 0.09, 0.11, 0.025), joint, 0, -0.03, 0));
            for (let f = 0; f < 3; f++) hand.add(mesh(box(0.022, 0.07, 0.024, 0.01), frame, -0.03 + f * 0.03, -0.1, -0.03));
            hand.add(mesh(box(0.024, 0.06, 0.024, 0.01), frame, s * 0.05, -0.06, -0.04));
            this.arms.push({ shoulder, elbow, hand });
            if (s > 0) {
                // The blaster: a grip, a body with a cell, a finned barrel, a sight.
                const gun = group(0, -0.08, -0.08);
                hand.add(gun);
                gun.add(mesh(box(0.06, 0.1, 0.34, 0.02), joint, 0, 0, -0.08));
                gun.add(mesh(box(0.07, 0.05, 0.12, 0.015), plate, 0, 0.06, -0.02));
                gun.add(mesh(box(0.03, 0.02, 0.1, 0.008), glow(2), 0, 0.03, -0.1));
                const barrel = mesh(cyl(0.022, 0.026, 0.22, 12), frame, 0, 0.015, -0.33);
                barrel.rotation.x = Math.PI / 2;
                gun.add(barrel);
                for (let k = 0; k < 3; k++) {
                    const fin = mesh(cyl(0.036, 0.036, 0.012, 12), joint, 0, 0.015, -0.26 - k * 0.05);
                    fin.rotation.x = Math.PI / 2;
                    gun.add(fin);
                }
                this.muzzle.position.set(0, 0.015, -0.46);
                gun.add(this.muzzle);
            }
        }

        // Legs: thigh with armour, knee cap, shin guard, ankle, a broad foot with a toe.
        for (const s of [-1, 1]) {
            const hip = group(s * 0.17, -0.04, 0);
            this.hips.add(hip);
            hip.add(mesh(capsule(0.075, 0.26), frame, 0, -0.22, 0));
            hip.add(mesh(box(0.17, 0.24, 0.17, 0.05), this.skin, s * 0.01, -0.2, -0.01));
            const knee = group(0, -0.45, 0);
            hip.add(knee);
            knee.add(mesh(sphere(0.07), joint));
            knee.add(mesh(box(0.11, 0.1, 0.06, 0.03), plate, 0, 0.01, -0.06));
            knee.add(mesh(box(0.15, 0.34, 0.16, 0.05), this.skin, 0, -0.21, 0.005));
            knee.add(mesh(box(0.02, 0.22, 0.02, 0.008), glow(1.1), s * 0.078, -0.2, -0.05));
            // Hydraulic pistons behind the knee.
            knee.add(mesh(cyl(0.015, 0.015, 0.3, 8), joint, 0, -0.18, 0.09));
            const ankle = group(0, -0.43, 0);
            knee.add(ankle);
            ankle.add(mesh(sphere(0.05), joint));
            ankle.add(mesh(box(0.15, 0.08, 0.3, 0.03), frame, 0, -0.03, -0.05));
            ankle.add(mesh(box(0.155, 0.02, 0.31, 0.008), rubber, 0, -0.07, -0.05));
            ankle.add(mesh(box(0.13, 0.05, 0.08, 0.02), plate, 0, -0.02, -0.2));
            this.legs.push({ hip, knee, ankle });
        }

        this.root.traverse(o => {
            const m = o as THREE.Mesh;
            if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
        });
    }

    /** Height of the eyes above the feet, m. */
    static readonly EYE = 1.9;

    /** Knocked back by a hit: a flinch and a red flash. */
    flinch() { this.hurt = 1; }

    /** Collapsed (destroyed) 0…1. */
    set collapsed(v: number) { this.down = v; }

    update(dt: number, pose: RobotPose) {
        this.time += dt;
        const lowG = pose.gravity < 3;
        // Stride: a longer, bounding one in low gravity.
        const stride = lowG ? 2.4 : pose.speed > 5 ? 1.9 : 1.35;
        if (pose.grounded) this.phase += (pose.speed / stride) * Math.PI * 2 * dt;
        const move = Math.min(pose.speed / 4.5, 1.6);
        const run = THREE.MathUtils.smoothstep(pose.speed, 4.5, 8);
        this.aimBlend += ((pose.aiming ? 1 : 0) - this.aimBlend) * (1 - Math.exp(-12 * dt));
        if (pose.grounded && !this.wasGrounded) this.landing = 1;
        this.wasGrounded = pose.grounded;
        this.landing = Math.max(0, this.landing - dt * 3);
        this.hurt = Math.max(0, this.hurt - dt * 4);

        const s = Math.sin(this.phase), c = Math.cos(this.phase);
        // Legs: swing and knee bend, out of step — or together, hopping, in low gravity.
        for (let i = 0; i < 2; i++) {
            const leg = this.legs[i];
            const ph = lowG ? this.phase + i * 0.35 : this.phase + i * Math.PI;
            const sw = Math.sin(ph), cw = Math.cos(ph);
            let hip = -sw * 0.55 * move * (1 + run * 0.3);
            let knee = Math.max(0, cw) * 0.9 * move * (1 + run * 0.5) + 0.05;
            let ankle = -hip * 0.4 - knee * 0.25;
            if (!pose.grounded) {
                // In the air: knees drawn up, one leg ahead.
                hip = -0.5 + i * 0.35;
                knee = 0.9 - i * 0.3;
                ankle = 0.2;
            }
            // Landing: a squat that springs back.
            knee += this.landing * 0.7;
            hip -= this.landing * 0.45;
            ankle -= this.landing * 0.25;
            leg.hip.rotation.x = hip;
            leg.knee.rotation.x = knee;
            leg.ankle.rotation.x = ankle;
        }
        // Body: bob and lean forward into the run; breathing when still.
        const bob = pose.grounded ? (lowG ? Math.abs(s) * 0.06 : Math.abs(c) * 0.035) * move : 0;
        this.hips.position.y = 0.98 - this.landing * 0.22 + bob - (1 - Math.min(move, 1)) * 0.0 - (pose.grounded ? 0.02 * move : 0);
        this.torso.rotation.x = -0.12 * move - run * 0.12 + this.hurt * 0.25;
        this.torso.rotation.y = (lowG ? 0 : s * 0.08 * move) * (1 - this.aimBlend);
        const breathe = 1 + Math.sin(this.time * 1.6) * 0.01 * (1 - Math.min(move, 1));
        this.torso.scale.set(breathe, 1, breathe);
        // Arms: counter-swing, raised for balance in the air; the right one comes up to aim.
        for (let i = 0; i < 2; i++) {
            const arm = this.arms[i];
            const ph = lowG ? this.phase + 0.35 * i : this.phase + i * Math.PI;
            let sh = Math.sin(ph) * 0.5 * move * (lowG ? 0.4 : 1);
            let el = -0.25 - Math.max(0, Math.sin(ph)) * 0.5 * move - run * 0.6;
            let side = (i ? -1 : 1) * (0.08 + (pose.grounded ? 0 : 0.45));
            if (!pose.grounded) { sh = -0.4; el = -0.6; }
            if (i === 1) {
                // Right arm: the blaster levelled at the crosshair.
                sh = THREE.MathUtils.lerp(sh, -Math.PI / 2 - pose.aimPitch, this.aimBlend);
                el = THREE.MathUtils.lerp(el, -0.05, this.aimBlend);
                side = THREE.MathUtils.lerp(side, 0.05, this.aimBlend);
            } else {
                // Left arm steadies the weapon.
                sh = THREE.MathUtils.lerp(sh, -1.1 - pose.aimPitch * 0.8, this.aimBlend * 0.8);
                el = THREE.MathUtils.lerp(el, -0.9, this.aimBlend * 0.8);
                side = THREE.MathUtils.lerp(side, 0.5, this.aimBlend * 0.8);
            }
            arm.shoulder.rotation.x = sh;
            arm.shoulder.rotation.z = side;
            arm.elbow.rotation.x = el;
        }
        // Head: follows the aim, glances about when idle.
        const idle = 1 - Math.min(move, 1);
        this.head.rotation.y = Math.sin(this.time * 0.37) * 0.35 * idle * (1 - this.aimBlend);
        this.head.rotation.x = -pose.aimPitch * 0.5 * this.aimBlend + Math.sin(this.time * 0.23) * 0.08 * idle;
        // Jets and lights.
        const flicker = 0.8 + 0.2 * Math.sin(this.time * 53) * Math.sin(this.time * 37);
        for (const f of this.flames) {
            f.visible = pose.jets;
            f.scale.set(1, flicker * (pose.jets ? 1 : 0.2), 1);
        }
        (this.beacon.material as THREE.MeshBasicMaterial).color.setHex(Math.sin(this.time * 4) > 0.6 ? 0xff4040 : 0x300808);
        const pulse = 2 + Math.sin(this.time * 2.2) * 0.4;
        for (const m of this.glowMats) m.emissiveIntensity = pulse * (this.down > 0 ? 1 - this.down : 1);
        this.skin.emissive.setRGB(this.hurt * 0.9, this.hurt * 0.1, 0);
        // Collapse: fold at the knees and topple.
        if (this.down > 0) {
            const d = this.down;
            for (const leg of this.legs) { leg.knee.rotation.x = 1.6 * d; leg.hip.rotation.x = -1.2 * d; }
            this.hips.position.y = 0.98 * (1 - d * 0.7);
            this.torso.rotation.x = 0.9 * d;
            this.head.rotation.x = 0.5 * d;
        }
    }

    dispose() {
        this.root.traverse(o => {
            const m = o as THREE.Mesh;
            if (m.isMesh) {
                m.geometry.dispose();
                (m.material as THREE.Material).dispose();
            }
        });
    }
}
