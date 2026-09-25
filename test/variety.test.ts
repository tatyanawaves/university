import { describe, expect, it } from 'vitest';
import { replyOptions, scriptedTurn, type Exchange } from '../universe/game/dialogue';
import { beingsFor } from '../universe/game/surfaceLife';
import { Vehicle } from '../universe/game/vehicle';
import { DEFAULT_LOOK, type CreatureMemory } from '../universe/game/progress';
import { worldLook } from '../universe/worlds';

const mars = { planet: 'Марс', bodies: ['Земля', 'Марс'], flora: false, hasAir: true, feature: 10, item: 'образцы грунта', seed: 3914 };

function talk(mem: CreatureMemory, choice: number): string[] {
    const mind = beingsFor(mars)[0];
    mem.talks++;
    const history: Exchange[] = [];
    let turn = scriptedTurn(mind, history, mem);
    const lines = [turn.line];
    while (!turn.quest) {
        history.push({ turn, reply: turn.options[choice] });
        turn = scriptedTurn(mind, history, mem);
        lines.push(turn.line);
    }
    return lines;
}

describe('conversations do not repeat', () => {
    it('tells new stories in a second talk', () => {
        const mem: CreatureMemory = { talks: 0, mood: 0, said: [], errands: [] };
        const first = talk(mem, 0).slice(1, -1).join(' ');
        const second = talk(mem, 0).slice(1, -1).join(' ');
        expect(second).not.toBe(first);
        expect((mem.told ?? []).length).toBeGreaterThan(2);
    });

    it('offers fresh replies, one of each tone, at every step', () => {
        const mind = beingsFor(mars)[0];
        const a = replyOptions(mind, 1, 1), b = replyOptions(mind, 1, 2);
        expect(a).toHaveLength(4);
        expect(a.join('|')).not.toBe(b.join('|'));
    });
});

describe('the rover', () => {
    const flat = () => 10;
    const free = () => false;
    it('drives forward on the ground and turns with the wheel', () => {
        const v = new Vehicle(DEFAULT_LOOK);
        v.place({ x: 0, y: 10.5, z: 0 } as never, 0);
        for (let i = 0; i < 120; i++) v.update(1 / 60, { throttle: 1, steer: 0, brake: false, boost: false }, flat, free, 9.8);
        expect(v.pos.z).toBeLessThan(-5); // nose along −Z
        expect(Math.abs(v.pos.y - 10.48)).toBeLessThan(0.05);
        const yaw0 = v.yaw;
        for (let i = 0; i < 60; i++) v.update(1 / 60, { throttle: 1, steer: 1, brake: false, boost: false }, flat, free, 9.8);
        expect(v.yaw).toBeLessThan(yaw0); // right turn
    });

    it('stops at an obstacle', () => {
        const v = new Vehicle(DEFAULT_LOOK);
        v.place({ x: 0, y: 10.5, z: 0 } as never, 0);
        for (let i = 0; i < 300; i++) v.update(1 / 60, { throttle: 1, steer: 0, brake: false, boost: false }, flat, (_x, z) => z < -8, 9.8);
        expect(v.pos.z).toBeGreaterThan(-8);
    });
});

describe('worlds nobody has seen', () => {
    it('get their own make-up from their name', () => {
        const looks = ['PTK 1 b', 'PTK 2 c', 'PTK 3 d', 'PTK 44 e', 'PTK 57 f'].map(n => worldLook(n, 'desert'));
        expect(new Set(looks.map(l => l.note)).size).toBeGreaterThan(1);
        const green = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => worldLook(`PTK ${n}`, 'earth').foliage!.join());
        expect(new Set(green).size).toBeGreaterThan(1);
        expect(worldLook('PTK 1 b', 'desert')).toEqual(worldLook('PTK 1 b', 'desert'));
    });
});
