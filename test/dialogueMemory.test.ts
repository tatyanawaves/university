import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatedCreatures, solarCreatures } from '../universe/game/creatures';
import {
    ACCEPT, BEATS, Conversation, MAX_REPLIES, MIN_REPLIES, orderOf, parsePlan, planTalk, repeats, temperament, uniquePlan,
} from '../universe/game/dialogue';
import { freshWorld, rememberOrder, type CreatureMemory, type SharedMemory } from '../universe/game/progress';
import { systemFacts } from '../universe/game/worldFacts';
import { SOLAR_SYSTEM, SUN } from '../universe/solarSystem';

const facts = systemFacts(SUN, SOLAR_SYSTEM);
const bodies = SOLAR_SYSTEM.flatMap(b => [b.name, ...(b.moons ?? []).map(m => m.name)]);
const world = { system: 'Солнечная система', bodies, facts };
const newShared = (): SharedMemory => ({ world: freshWorld(), creatures: {} });

/** A whole scripted talk, the pilot always answering in one tone; returns the creature's lines. */
async function talk(shared: SharedMemory, id: string, tone: number): Promise<string[]> {
    const mind = solarCreatures().find(c => c.id === id)!;
    const mem = (shared.creatures[id] ??= { talks: 0, mood: 0, said: [], errands: [] });
    mem.talks++;
    const c = new Conversation(mind, world, mem, shared);
    let turn = await c.open();
    const lines = [turn.line];
    while (!turn.quest) {
        turn = await c.answer(turn.options[tone]);
        lines.push(turn.line);
    }
    return lines;
}

describe('the order of a talk', () => {
    it('is never the same twice, for any creature', async () => {
        const shared = newShared();
        for (let round = 0; round < 6; round++)
            for (const c of solarCreatures()) await talk(shared, c.id, round % 4);
        const orders = shared.world.orders;
        expect(orders).toHaveLength(60);
        expect(new Set(orders).size).toBe(orders.length);
        for (const o of orders) {
            const beats = o.split('>');
            expect(beats.length).toBeGreaterThanOrEqual(MIN_REPLIES - 1);
            expect(beats.length).toBeLessThanOrEqual(MAX_REPLIES - 1);
            expect(beats.filter(b => b === 'trouble')).toHaveLength(1);
        }
    });

    it('leans each creature its own way', () => {
        const leanings = solarCreatures().map(c => BEATS.map(b => temperament(c)[b].toFixed(3)).join());
        expect(new Set(leanings).size).toBe(solarCreatures().length);
    });

    it('steps aside from an order already used', () => {
        const [oira] = solarCreatures();
        const shared = newShared();
        const plan = planTalk(oira, undefined, shared, world);
        rememberOrder(shared.world, orderOf(plan));
        expect(orderOf(uniquePlan(plan, oira, shared, world))).not.toBe(orderOf(plan));
        expect(orderOf(planTalk(oira, undefined, shared, world))).not.toBe(orderOf(plan));
    });

    it('takes a model\'s plan, with exactly one trouble, and not too long', () => {
        const p = parsePlan('{"line":"…","plan":[{"beat":"trouble"},{"beat":"joke","topic":"про кометы"},"fact","dance",{"beat":"trouble"},"dream","story","rumor","gossip","question"]}')!;
        expect(p.beats.filter(b => b === 'trouble')).toHaveLength(1);
        expect(p.beats.length).toBeLessThanOrEqual(MAX_REPLIES - 1);
        expect(p.beats).not.toContain('dance');
        expect(parsePlan('{"line":"без плана"}')).toBeNull();
        expect(parsePlan('{"plan":["joke","fact"]}')!.beats).toEqual(['joke', 'fact', 'trouble']);
    });
});

describe('what creatures say', () => {
    it('is never said twice in the world, across creatures and talks', async () => {
        const shared = newShared();
        const all: string[] = [];
        for (let round = 0; round < 3; round++)
            for (const c of solarCreatures()) {
                const lines = await talk(shared, c.id, (round + 1) % 4);
                // The greeting of a second talk and the errand repeat on purpose; the talk between does not.
                all.push(...lines.slice(1, -1));
            }
        expect(all.length).toBeGreaterThanOrEqual(90);
        expect(all.filter((l, i) => all.indexOf(l) !== i)).toEqual([]);
    });

    it('tells true facts of the system', async () => {
        expect(facts.some(f => f.includes('Земля') && f.includes('8,3 мин'))).toBe(true);
        expect(facts.some(f => f.includes('Венера') && f.includes('обратное'))).toBe(true);
        const shared = newShared();
        const lines: string[] = [];
        for (let round = 0; round < 3; round++) for (const c of solarCreatures()) lines.push(...await talk(shared, c.id, 0));
        expect(lines.some(l => facts.some(f => l.includes(f)))).toBe(true);
    });

    it('carries word of the pilot from one creature to the others', async () => {
        const shared = newShared();
        await talk(shared, 'oira', 2); // rude all the way
        expect(shared.world.deeds.some(d => d.text.includes('Ойра'))).toBe(true);
        shared.world.kills = { drone: 7 };
        const heard: string[] = [];
        for (let round = 0; round < 4; round++)
            for (const c of solarCreatures().filter(x => x.id !== 'oira')) heard.push(...await talk(shared, c.id, 1));
        expect(heard.some(l => l.includes('Ойра'))).toBe(true);
        expect(heard.some(l => l.includes('дроны — 7'))).toBe(true);
    });

    it('in a generated system too', async () => {
        const planets = ['PTK 7 b', 'PTK 7 c', 'PTK 7 d'];
        const shared = newShared();
        const w = { system: 'Система PTK 7', bodies: planets, facts: ['PTK 7 b: до звезды 0,4 а.е.'] };
        for (const mind of generatedCreatures(planets, 7)) {
            const mem: CreatureMemory = { talks: 1, mood: 0, said: [], errands: [] };
            const c = new Conversation(mind, w, mem, shared);
            let turn = await c.open();
            for (let i = 0; !turn.quest && i < MAX_REPLIES + 1; i++) turn = await c.answer(turn.options[3]);
            expect(turn.options[0]).toBe(ACCEPT);
        }
    });
});

describe('a live model', () => {
    const store = new Map<string, string>();
    afterEach(() => { vi.unstubAllGlobals(); store.clear(); });

    it('makes up the order, is kept from repeating itself, and is heard by the world', async () => {
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
        store.set('ai_settings', JSON.stringify({ aiProvider: 'groq', groqKey: 'test' }));
        const replies = [
            { line: 'Здравствуй, огонёк, я Ойра.', options: ['a', 'b', 'c', 'd'], quest: null, plan: [{ beat: 'joke', topic: 'про пиратов' }, { beat: 'fact', topic: 'Луна уходит' }, { beat: 'trouble', topic: 'дроны' }] },
            { line: 'Пираты так скупы, что торгуются даже с эхом у Луны.', options: ['a', 'b', 'c', 'd'], quest: null },
            // The same again: the game asks once more.
            { line: 'Пираты так скупы, что торгуются даже с эхом у Луны!', options: ['a', 'b', 'c', 'd'], quest: null },
            { line: 'Луна уходит от Земли примерно на 3,8 см в год, знаешь?', options: ['a', 'b', 'c', 'd'], quest: null },
        ];
        const systems: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
            systems.push(JSON.parse(init.body).messages[0].content);
            const next = replies.shift()!;
            return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(next) } }] }) };
        }));
        const [oira] = solarCreatures();
        const shared = newShared();
        const c = new Conversation(oira, world, { talks: 1, mood: 0, said: [], errands: [] }, shared);
        expect(c.offline).toBe(false);
        await c.open();
        expect(c.plan!.beats).toEqual(['joke', 'fact', 'trouble']);
        expect(shared.world.orders).toEqual(['joke>fact>trouble']);
        expect(systems[0]).toContain('"plan"');
        await c.answer('a');
        expect(systems[1]).toContain('Сейчас шаг 1');
        expect(systems[1]).toContain('про пиратов');
        const t = await c.answer('b');
        expect(t.line).toContain('3,8 см');
        expect(shared.world.told).toHaveLength(3);
        expect(systems[3]).toContain('Пираты так скупы'); // told lines go back to the model as off-limits
    });

    it('spots a line said before', () => {
        expect(repeats('Пираты прячут добычу в тени спутников!', ['пираты прячут добычу в тени спутников'])).toBe(true);
        expect(repeats('Сегодня звёзды поют тише обычного.', ['Пираты прячут добычу в тени спутников.'])).toBe(false);
    });
});
