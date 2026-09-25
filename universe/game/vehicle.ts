// The ship's rover: a four-wheeled buggy with a roll cage, glowing trim and
// head lamps, stowed in the hold. Called up, it drives itself down the ramp
// to the robot; the robot climbs in and drives: throttle and steering, a
// suspension that follows the ground under each wheel, jumps off crests in
// low gravity, and a brake. Metres, nose along −Z.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ShipLook } from './progress';

const rbox = (w: number, h: number, d: number, r = 0.08) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));
const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T => { o.position.set(x, y, z); return o; };

/** Wheel positions (x, z) relative to the body; the body's origin is at axle height. */
const WHEELS: [number, number][] = [[-1.05, -1.25], [1.05, -1.25], [-1.05, 1.3], [1.05, 1.3]];
const WHEEL_R = 0.48;
/** Where the robot sits, relative to the body. */
export const SEAT = new THREE.Vector3(0, 0.15, 0.25);

export interface DriveInput { throttle: number; steer: number; brake: boolean; boost: boolean }

export class Vehicle {
    readonly root = new THREE.Group();
    private body = new THREE.Group();
    private wheels: THREE.Group[] = [];
    readonly lamp = new THREE.SpotLight(0xfff1dc, 0, 70, 0.55, 0.5, 1.2);
    readonly pos = new THREE.Vector3();
    yaw = 0;
    speed = 0;
    private vy = 0;
    private airborne = false;
    private pitch = 0;
    private roll = 0;
    private spin = 0;
    private steerAngle = 0;
    private time = 0;

    constructor(look: ShipLook) {
        const paint = new THREE.MeshStandardMaterial({ color: new THREE.Color(look.hull), metalness: 0.6, roughness: 0.3 });
        const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(look.accent), metalness: 0.7, roughness: 0.4 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.5, roughness: 0.5 });
        const tyre = new THREE.MeshStandardMaterial({ color: 0x101113, metalness: 0, roughness: 0.95 });
        const glow = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: new THREE.Color(look.glow), emissiveIntensity: 2.4 });
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1dc, emissiveIntensity: 3 });
        const tail = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2020, emissiveIntensity: 2.5 });
        this.root.add(this.body);
        // Chassis: a low tub with a raked nose, side pods, a seat and a roll cage.
        this.body.add(at(new THREE.Mesh(rbox(1.9, 0.45, 3.6, 0.2), paint), 0, 0.2, 0));
        const nose = at(new THREE.Mesh(rbox(1.7, 0.35, 1.1, 0.16), paint), 0, 0.28, -1.95);
        nose.rotation.x = 0.18;
        this.body.add(nose);
        this.body.add(at(new THREE.Mesh(rbox(1.95, 0.12, 3.3, 0.05), dark), 0, -0.05, 0));
        for (const s of [-1, 1]) {
            this.body.add(at(new THREE.Mesh(rbox(0.28, 0.35, 2.6, 0.12), trim), s * 1.02, 0.3, 0.05));
            this.body.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 2.4), glow), s * 1.17, 0.32, 0.05));
            // Fenders over each wheel.
            for (const z of [-1.25, 1.3]) {
                const f = at(new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 20, 1, true, 0, Math.PI), trim), s * 1.05, 0.05, z);
                f.rotation.z = Math.PI / 2;
                f.rotation.y = Math.PI / 2;
                f.material = trim;
                (f.material as THREE.Material).side = THREE.DoubleSide;
                this.body.add(f);
            }
            this.body.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.04), lampMat), s * 0.55, 0.36, -2.5));
            this.body.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.04), tail), s * 0.7, 0.35, 1.82));
        }
        // Seat and dashboard.
        this.body.add(at(new THREE.Mesh(rbox(0.8, 0.2, 0.7, 0.08), dark), 0, 0.5, 0.35));
        this.body.add(at(new THREE.Mesh(rbox(0.8, 0.8, 0.18, 0.08), dark), 0, 0.85, 0.72));
        this.body.add(at(new THREE.Mesh(rbox(1.4, 0.25, 0.4, 0.08), trim), 0, 0.62, -0.75));
        this.body.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.02), glow), 0, 0.78, -0.62));
        const wheelBar = at(new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 8, 20), dark), 0, 0.85, -0.45);
        wheelBar.rotation.x = -1.1;
        this.body.add(wheelBar);
        // Roll cage: two hoops and rails.
        const bar = (a: THREE.Vector3, b: THREE.Vector3) => {
            const len = a.distanceTo(b);
            const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, len, 8), trim);
            m.position.copy(a).add(b).multiplyScalar(0.5);
            m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
            this.body.add(m);
        };
        const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
        for (const z of [-0.55, 1.05]) { bar(P(-0.85, 0.4, z), P(-0.7, 1.75, z)); bar(P(0.85, 0.4, z), P(0.7, 1.75, z)); bar(P(-0.7, 1.75, z), P(0.7, 1.75, z)); }
        bar(P(-0.7, 1.75, -0.55), P(-0.7, 1.75, 1.05));
        bar(P(0.7, 1.75, -0.55), P(0.7, 1.75, 1.05));
        this.body.add(at(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.2), lampMat), 0, 1.78, -0.55)); // light bar
        // Antenna with a flag light.
        this.body.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.3, 4), dark), 0.75, 2.4, 1.05));
        this.body.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), glow), 0.75, 3.05, 1.05));
        // Wheels: a fat tyre with tread blocks and a glowing hub.
        for (const [x, z] of WHEELS) {
            const w = at(new THREE.Group(), x, 0, z);
            const spinner = new THREE.Group();
            spinner.name = 'spin';
            const t = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.42, 24), tyre);
            t.rotation.z = Math.PI / 2;
            spinner.add(t);
            for (let k = 0; k < 12; k++) {
                const a = (k / 12) * Math.PI * 2;
                const lug = at(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.07, 0.12), tyre), 0, Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R);
                lug.rotation.x = -a;
                spinner.add(lug);
            }
            const hub = at(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.44, 16), glow), 0, 0, 0);
            hub.rotation.z = Math.PI / 2;
            spinner.add(hub);
            w.add(spinner);
            this.root.add(w);
            this.wheels.push(w);
        }
        this.lamp.position.set(0, 0.6, -2.4);
        this.lamp.target.position.set(0, -1, -12);
        this.body.add(this.lamp, this.lamp.target);
    }

    /** Put it somewhere (e.g. at the top of the ramp), facing `yaw`. */
    place(p: THREE.Vector3, yaw: number) {
        this.pos.copy(p);
        this.yaw = yaw;
        this.speed = 0;
        this.vy = 0;
    }

    get forward(): THREE.Vector3 { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

    /** Where the robot sits, in the world. */
    seatWorld(): THREE.Vector3 {
        this.root.updateMatrixWorld(true);
        return SEAT.clone().applyMatrix4(this.body.matrixWorld);
    }

    get bodyQuaternion(): THREE.Quaternion {
        return this.body.getWorldQuaternion(new THREE.Quaternion());
    }

    /**
     * One step of driving. `ground` gives the height under a point; `blocked` says if a point is
     * inside something (a trunk, a boulder, deep water). `gravity` in m/s².
     */
    update(dt: number, input: DriveInput, ground: (x: number, z: number) => number, blocked: (x: number, z: number) => boolean, gravity: number) {
        this.time += dt;
        const max = input.boost ? 26 : 16;
        // Throttle, brake, rolling resistance; slower in reverse.
        const target = input.throttle >= 0 ? input.throttle * max : input.throttle * 6;
        const accel = this.airborne ? 0 : input.brake ? 18 : 7;
        this.speed += THREE.MathUtils.clamp((input.brake ? 0 : target) - this.speed, -accel * dt, accel * dt);
        if (!this.airborne && input.throttle === 0 && !input.brake) this.speed *= Math.exp(-0.6 * dt);
        // Steering: the front wheels turn, the turn rate grows with speed (a bicycle model).
        this.steerAngle += (input.steer * 0.55 - this.steerAngle) * (1 - Math.exp(-8 * dt));
        if (!this.airborne) this.yaw -= (this.speed / 2.55) * Math.tan(this.steerAngle) * dt;
        // Move, unless that runs into something.
        const f = this.forward;
        const nx = this.pos.x + f.x * this.speed * dt, nz = this.pos.z + f.z * this.speed * dt;
        if (blocked(nx + f.x * 1.8, nz + f.z * 1.8) && this.speed > 0 || blocked(nx - f.x * 1.8, nz - f.z * 1.8) && this.speed < 0) {
            this.speed *= -0.25; // a bump off it
        } else { this.pos.x = nx; this.pos.z = nz; }
        // Suspension: the body sits on the four wheels' ground; off a crest it flies.
        const r = new THREE.Vector3(-f.z, 0, f.x);
        const hs = WHEELS.map(([x, z]) => ground(this.pos.x + r.x * x - f.x * z, this.pos.z + r.z * x - f.z * z));
        const floor = (hs[0] + hs[1] + hs[2] + hs[3]) / 4 + WHEEL_R;
        if (this.airborne) {
            this.vy -= gravity * dt;
            this.pos.y += this.vy * dt;
            if (this.pos.y <= floor) { this.pos.y = floor; this.airborne = false; this.vy = 0; }
        } else {
            const rise = (floor - this.pos.y) / Math.max(dt, 1e-3);
            // Launch off a crest when the ground drops away faster than gravity can pull the car down.
            if (floor < this.pos.y - 0.05 && this.vy - gravity * dt > rise) {
                this.airborne = true;
                this.vy = Math.max(this.vy, 0);
            } else {
                this.vy = THREE.MathUtils.clamp(rise, -30, 30);
                this.pos.y = floor;
            }
        }
        const pitchT = Math.atan2((hs[2] + hs[3]) - (hs[0] + hs[1]), 2 * 2.55) * -1;
        const rollT = Math.atan2((hs[1] + hs[3]) - (hs[0] + hs[2]), 2 * 2.1);
        const k = 1 - Math.exp(-(this.airborne ? 1.5 : 10) * dt);
        this.pitch += (pitchT - this.pitch) * k;
        this.roll += (rollT - this.roll) * k;
        this.root.position.copy(this.pos);
        this.root.rotation.set(0, this.yaw, 0);
        this.body.rotation.set(this.pitch, 0, this.roll, 'YXZ');
        // Wheels: spin with the ground speed, the front ones steer, each finds its own ground.
        this.spin += (this.speed / WHEEL_R) * dt;
        this.wheels.forEach((w, i) => {
            const [x, z] = WHEELS[i];
            w.position.set(x, this.airborne ? -0.25 : THREE.MathUtils.clamp(hs[i] + WHEEL_R - this.pos.y, -0.35, 0.35), z);
            w.rotation.y = i < 2 ? -this.steerAngle : 0;
            (w.getObjectByName('spin') as THREE.Object3D).rotation.x = -this.spin;
        });
    }

    /** Drive itself towards a point (summoned): returns true once there. */
    autoDrive(dt: number, to: THREE.Vector3, ground: (x: number, z: number) => number, blocked: (x: number, z: number) => boolean, gravity: number): boolean {
        const d = new THREE.Vector3(to.x - this.pos.x, 0, to.z - this.pos.z);
        const dist = d.length();
        if (dist < 2.5) {
            this.update(dt, { throttle: 0, steer: 0, brake: true, boost: false }, ground, blocked, gravity);
            return Math.abs(this.speed) < 0.3;
        }
        const want = Math.atan2(-d.x, -d.z);
        let err = want - this.yaw;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        const throttle = dist > 25 ? 0.8 : 0.35;
        this.update(dt, { throttle: Math.abs(err) > 1.4 ? 0.25 : throttle, steer: THREE.MathUtils.clamp(-err * 2, -1, 1), brake: false, boost: false }, ground, blocked, gravity);
        return false;
    }

    set lampOn(v: number) { this.lamp.intensity = v; }

    dispose() {
        this.root.traverse(o => {
            const m = o as THREE.Mesh;
            if (m.isMesh) { m.geometry.dispose(); }
        });
    }
}
