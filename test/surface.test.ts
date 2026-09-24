import { describe, expect, it } from 'vitest';
import { sanitizeQuest, scriptedTurn, type Exchange } from '../universe/game/dialogue';
import { collect, kill, mission, MissionLog } from '../universe/game/missions';
import { beingsFor, foesFor, FOES } from '../universe/game/surfaceLife';
import { worldLook } from '../universe/worlds';
import { surfaceFor } from '../universe/atmosphere';

const mars = { planet: 'Марс', bodies: ['Земля', 'Марс', 'Фобос', 'Юпитер'], flora: false, hasAir: true, feature: 10, item: 'образцы грунта', seed: 3914 };

describe('beings on a surface', () => {
    it('are the same every visit, and each ends its talk with a job', () => {
        const a = beingsFor(mars), b = beingsFor(mars);
        expect(a.map(x => x.name)).toEqual(b.map(x => x.name));
        expect(a.length).toBeGreaterThanOrEqual(3);
        for (const being of a) {
            const history: Exchange[] = [];
            let turn = scriptedTurn(being, history);
            while (!turn.quest) {
                history.push({ turn, reply: turn.options[0] });
                turn = scriptedTurn(being, history);
            }
            expect(['kill', 'collect', 'reach']).toContain(turn.quest.type);
            if (turn.quest.type === 'collect') expect(turn.quest.item).toBe(mars.item);
        }
    });

    it('know the enemies of their world', () => {
        for (const f of foesFor('Марс', false, 10)) expect(FOES[f].hp).toBeGreaterThan(0);
        expect(foesFor('Земля', true, 0)).toContain('brute');
    });
});

describe('jobs on foot', () => {
    const world = { system: 'Солнечная система', bodies: mars.bodies, surface: { body: 'Марс', foes: foesFor('Марс', false, 10), item: mars.item } };
    const mind = beingsFor(mars)[0];

    it('keep ground enemies and gathering on this surface', () => {
        const k = sanitizeQuest({ type: 'kill', enemy: 'sentinel', count: 40, body: 'Юпитер' }, world, mind)!;
        expect(k.body).toBe('Марс');
        expect(k.count).toBe(4);
        const c = sanitizeQuest({ type: 'collect', count: 100 }, world, mind)!;
        expect(c).toMatchObject({ type: 'collect', item: mars.item, count: 8, body: 'Марс' });
        // Space jobs may point elsewhere.
        expect(sanitizeQuest({ type: 'kill', enemy: 'drone', count: 3, body: 'Фобос' }, world, mind)!.body).toBe('Фобос');
        // No gathering from a creature out in space.
        expect(sanitizeQuest({ type: 'collect', count: 3 }, { system: 's', bodies: ['Марс'] }, mind)).toBeNull();
    });

    it('count picked-up samples and kills of ground enemies', () => {
        const log = new MissionLog([]);
        const m = log.addSide(mission('side-x', 'Сбор', '…', 'Марс', [], [collect(mars.item, 'Марс', 2), kill('skitter', 1)], 300), 0);
        expect(log.collect('чужое')).toBe(false);
        log.collect(mars.item); log.collect(mars.item);
        expect(m.state).toBe('active');
        log.kill('skitter');
        expect(m.state).toBe('done');
    });
});

describe('what worlds are made of', () => {
    it('gives every real world its own surface, and Earth its seas, clouds and forests', () => {
        const earth = surfaceFor('Земля', 'earth', 6371, 9.8);
        expect(earth.look.flora && earth.look.liquid && earth.look.clouds).toBeTruthy();
        expect(worldLook('Титан', 'moon').liquid?.name).toContain('метан');
        expect(worldLook('Ио', 'moon').material.feature).not.toBe(worldLook('Европа', 'moon').material.feature);
        expect(surfaceFor('Луна', 'moon', 1737, 1.62).look.clouds).toBeNull();
    });
});
