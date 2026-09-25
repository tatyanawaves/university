// Conversations with the creatures of space. A creature opens the talk, the
// pilot picks one of four replies, and it goes on until the creature hands
// out an errand. The lines come from the language model the pilot set up in
// Potok (their own key, from this browser's storage); without one, or when
// the model fails, the creature falls back on a scripted conversation.
//
// Every talk has its own order of what the creature talks about (a plan):
// the model makes it up at the start, or the game does, after the creature's
// own leanings; no order is ever used twice, by anyone. Creatures share one
// memory: what the pilot did, what the others think of the pilot, and every
// line already said, so nobody says it again. And they know true facts about
// the system they live in.

import { hash32, mulberry32 } from '../mandelbrot';
import { secureStorage } from '../storage';
import type { EnemyKind } from './models';
import { rememberDeed, rememberOrder, rememberTold, type CreatureMemory, type SharedMemory } from './progress';
import { isGround, type FoeKind, type GroundKind } from './missions';

export interface QuestOffer {
    title: string;
    brief: string;
    /** Destroy enemies (in space, or on foot on a surface), fly to a body, or gather things on a surface. */
    type: 'kill' | 'reach' | 'collect';
    enemy?: FoeKind;
    /** For 'collect': what to pick up. */
    item?: string;
    count?: number;
    body: string;
    reward: number;
}

export interface DialogueTurn {
    line: string;
    /** Four replies for the pilot; after an errand is offered, the ways to accept or refuse it. */
    options: string[];
    quest: QuestOffer | null;
}

export interface CreatureMind {
    name: string;
    species: string;
    persona: string;
    /** The body it lives by. */
    home: string;
    /** The errand it has in mind, for the scripted conversation (the model may choose its own). */
    wish: Omit<QuestOffer, 'title' | 'brief' | 'reward'> & { why: string; title: string; reward: number };
    /**
     * Scripted lines: the call it makes when a ship comes near, its greeting, stories about
     * itself, a question for the pilot, a rumour about the system, and the trouble it is in.
     */
    script: { hail: string; greet: string; lore: string[]; ask: string; rumor: string; trouble: string };
}

export interface WorldBrief {
    system: string;
    /** Bodies an errand may point at. */
    bodies: string[];
    /** Set when the talk happens on a planet's surface, with the pilot's robot. */
    surface?: {
        body: string;
        /** Enemies that roam this surface. */
        foes: GroundKind[];
        /** What can be gathered here, in the genitive plural («образцов серы»). */
        item: string;
    };
    /** True things about this system (see worldFacts.ts), for the creatures to tell. */
    facts?: string[];
}

export interface Exchange {
    /** The creature's turn, and the pilot's answer to it (absent for the turn being shown). */
    turn: DialogueTurn;
    reply?: string;
}

const ENEMIES: EnemyKind[] = ['drone', 'fighter', 'crystal', 'leviathan', 'interceptor', 'gunship', 'hive'];
/** A creature talks for at least this many pilot replies before it asks for anything… */
export const MIN_REPLIES = 4;
/** …and gets to its errand by this many at the latest. */
export const MAX_REPLIES = 8;

export const ACCEPT = 'Берусь за поручение.';
export const DECLINE = 'Не сейчас, может быть позже.';

// ---------------------------------------------------------------------------
// Validation: whatever the model says, the game only gets an errand it can run.
// ---------------------------------------------------------------------------

/** Most of one kind of enemy an errand may ask for. */
const MAX_COUNT: Record<FoeKind, number> = {
    drone: 12, fighter: 12, crystal: 12, interceptor: 12, gunship: 2, hive: 1, leviathan: 1,
    skitter: 10, sentinel: 4, wraith: 5, brute: 2,
};

export function sanitizeQuest(q: unknown, world: WorldBrief, mind: CreatureMind): QuestOffer | null {
    if (!q || typeof q !== 'object') return null;
    const o = q as Record<string, unknown>;
    const surface = world.surface;
    const type = o.type === 'reach' ? 'reach' : o.type === 'kill' ? 'kill' : o.type === 'collect' && surface ? 'collect' : null;
    if (!type) return null;
    const bodyName = typeof o.body === 'string' ? o.body.trim() : '';
    let body = world.bodies.find(b => b.toLowerCase() === bodyName.toLowerCase()) ?? mind.home;
    const clamp = (x: unknown, lo: number, hi: number, dflt: number) => {
        const n = Math.round(Number(x));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    const text = (x: unknown, dflt: string, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : dflt);
    const known = (k: unknown): k is FoeKind => typeof k === 'string' && (ENEMIES.includes(k as EnemyKind) || (!!surface && surface.foes.includes(k as GroundKind)));
    const enemy: FoeKind = known(o.enemy) ? o.enemy : surface?.foes[0] ?? 'drone';
    // Enemies on foot live on this surface; the things to gather lie here too.
    if ((type === 'kill' && isGround(enemy)) || type === 'collect') body = surface!.body;
    const max = type === 'collect' ? 8 : MAX_COUNT[enemy];
    const count = type === 'reach' ? undefined : type === 'collect' ? clamp(o.count, 2, 8, 4) : clamp(o.count, 1, max, Math.min(4, max));
    const brief = type === 'kill' ? `Помочь у тела ${body}.` : type === 'collect' ? `Собрать ${surface!.item} здесь, на поверхности.` : `Долететь до ${body}.`;
    return {
        type, body, count,
        enemy: type === 'kill' ? enemy : undefined,
        item: type === 'collect' ? surface!.item : undefined,
        title: text(o.title, `Поручение: ${mind.name}`, 60),
        brief: text(o.brief, brief, 240),
        reward: clamp(o.reward, 100, 1500, 400),
    };
}

/** Pull a turn out of a model's reply, which may wrap its JSON in prose or code fences. */
export function parseTurn(raw: string, world: WorldBrief, mind: CreatureMind): DialogueTurn | null {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let j: Record<string, unknown>;
    try { j = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
    const line = typeof j.line === 'string' ? j.line.trim() : '';
    if (!line) return null;
    const quest = sanitizeQuest(j.quest, world, mind);
    let options = Array.isArray(j.options) ? j.options.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim().slice(0, 140)) : [];
    if (quest) options = [ACCEPT, DECLINE];
    else {
        const pad = ['Расскажи подробнее.', 'Чем я могу помочь?', 'Ты мне не нравишься.', 'Откуда ты?'];
        for (const p of pad) if (options.length < 4 && !options.includes(p)) options.push(p);
        options = options.slice(0, 4);
    }
    return { line: line.slice(0, 600), options, quest };
}

// ---------------------------------------------------------------------------
// The pilot's own model, as configured in Potok.
// ---------------------------------------------------------------------------

interface ModelAccess { provider: 'openrouter' | 'groq' | 'gemini'; key: string; model: string; baseUrl?: string }

export function modelAccess(): ModelAccess | null {
    try {
        const settings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
        const keys = {
            openrouter: settings.openRouterKey || secureStorage.getItem('openRouterKey') || '',
            groq: settings.groqKey || secureStorage.getItem('groqKey') || '',
            gemini: settings.geminiKey || secureStorage.getItem('geminiKey') || '',
        };
        const order: ModelAccess['provider'][] = [settings.aiProvider, 'openrouter', 'groq', 'gemini']
            .filter((p): p is ModelAccess['provider'] => p === 'openrouter' || p === 'groq' || p === 'gemini');
        const provider = order.find(p => keys[p]);
        if (!provider) return null;
        const model = provider === 'openrouter' ? settings.openRouterModel || 'openrouter/auto'
            : provider === 'groq' ? settings.groqModel || 'llama-3.3-70b-versatile'
                : settings.geminiModel || 'gemini-2.5-flash';
        return { provider, key: keys[provider], model, baseUrl: provider === 'openrouter' ? settings.apiBaseUrl : undefined };
    } catch {
        return null;
    }
}

export type Provider = ModelAccess['provider'];

/** Keep the pilot's own key in this browser (encrypted, as Potok keeps it), and make it the one used. */
export function saveModelKey(provider: Provider, key: string) {
    const name = provider === 'openrouter' ? 'openRouterKey' : provider === 'groq' ? 'groqKey' : 'geminiKey';
    secureStorage.setItem(name, key.trim());
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(localStorage.getItem('ai_settings') || '{}'); } catch { /* start afresh */ }
    delete settings[name]; // never in the plain blob
    localStorage.setItem('ai_settings', JSON.stringify({ ...settings, aiProvider: provider }));
}

export function describeAccess(a: ModelAccess | null): string {
    if (!a) return 'сценарий (ИИ не подключён)';
    return `ИИ: ${a.provider === 'openrouter' ? 'OpenRouter' : a.provider === 'groq' ? 'Groq' : 'Gemini'} · ${a.model}`;
}

function memoryPrompt(mem?: CreatureMemory): string[] {
    if (!mem || mem.talks <= 1) return ['Это ваша первая встреча.'];
    const errands = mem.errands.map(e => `«${e.title}» — ${e.state === 'done' ? 'выполнено' : e.state === 'failed' ? 'провалено' : 'ещё не выполнено'}`);
    return [
        `Вы уже встречались: это ваш ${mem.talks}-й разговор. Твоё отношение к пилоту: ${moodText(mem.mood)}.`,
        mem.said.length ? `Раньше пилот говорил тебе: ${mem.said.slice(-4).map(x => `«${x}»`).join(', ')}.` : '',
        errands.length ? `Твои поручения ему: ${errands.join('; ')}.` : '',
        mem.told?.length ? `Ты уже рассказывала(рассказывал) ему: ${mem.told.slice(-5).map(x => `«${x.slice(0, 80)}»`).join(', ')} — не повторяйся, расскажи новое.` : '',
        'Начни с того, что узнаёшь пилота и вспоминаешь прошлое (поблагодари за выполненное, упрекни за проваленное или грубость).',
    ];
}

/** Facts about this world not yet told to the pilot: those about the creature's home first, the rest from a place of its own. */
function freshFacts(world: WorldBrief, home: string, known: (x: string) => boolean, seed = 0): string[] {
    const all = (world.facts ?? []).filter(f => !known(f));
    const rest = all.filter(f => !f.includes(home));
    const k = rest.length ? Math.abs(seed) % rest.length : 0;
    return [...all.filter(f => f.includes(home)), ...rest.slice(k), ...rest.slice(0, k)];
}

/** Enemies in the plural, for talk of the pilot's fights. */
export const ENEMY_RU: Record<string, string> = {
    drone: 'дроны', fighter: 'пиратские штурмовики', crystal: 'кристаллиды', leviathan: 'левиафан',
    interceptor: 'перехватчики', gunship: 'канонерки', hive: 'улей',
    skitter: 'скиттеры', sentinel: 'шагоходы-стражи', wraith: 'призрачные охотники', brute: 'громилы',
};

/** What the world has heard of the pilot's doings, newest first (not what the creature itself told of). */
function deedsOf(shared?: SharedMemory, mind?: CreatureMind): string[] {
    if (!shared) return [];
    const out = shared.world.deeds.slice().reverse().map(d => d.text).filter(t => !mind || !t.endsWith(`по имени ${mind.name}`));
    const kills = Object.entries(shared.world.kills).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (kills.length) out.push(`уничтожил(а) врагов: ${kills.slice(0, 4).map(([k, n]) => `${ENEMY_RU[k] ?? k} — ${n}`).join(', ')}`);
    return out;
}

/** The other creatures the pilot has met, who talk among themselves. */
function others(mind: CreatureMind, shared?: SharedMemory): CreatureMemory[] {
    return shared ? Object.values(shared.creatures).filter(m => m.name && m.name !== mind.name && m.talks > 0) : [];
}

/** What each of the others says about the pilot. */
function gossipOf(mind: CreatureMind, shared?: SharedMemory): string[] {
    return others(mind, shared).map(m => {
        const last = m.errands[m.errands.length - 1];
        if (last?.state === 'done') return `${m.name} всем рассказывает, как ты выполнил(а) «${last.title}».`;
        if (last?.state === 'failed') return `${m.name} жалуется, что «${last.title}» ты так и не сделал(а).`;
        if (m.mood <= -1) return `${m.name} говорит, что ты грубиян и с тобой лучше не связываться.`;
        if (m.mood >= 1) return `${m.name} отзывается о тебе очень тепло: говорит, ты умеешь слушать.`;
        return `${m.name} говорит, что вы уже встречались, но что ты за пилот, пока не разобрать.`;
    });
}

/** What the world shares with a creature before it speaks: facts, deeds, gossip, and what was already said. */
function sharedPrompt(mind: CreatureMind, world: WorldBrief, known: (x: string) => boolean, shared?: SharedMemory): string[] {
    const facts = freshFacts(world, mind.home, known, nameSeed(mind.name)).slice(0, 8);
    const deeds = deedsOf(shared, mind).slice(0, 6);
    const gossip = gossipOf(mind, shared).slice(0, 4);
    const told = (shared?.world.told ?? []).slice(-20);
    return [
        facts.length ? `Правдивые факты об этом мире (рассказывай их своими словами, цифры не выдумывай): ${facts.join(' ')}` : '',
        deeds.length ? `Что в мире слышали о делах пилота: ${deeds.join('; ')}.` : '',
        gossip.length ? `Что о пилоте говорят другие существа (вы все знакомы и болтаете между собой): ${gossip.join(' ')}` : '',
        told.length ? `Это уже звучало — от тебя или от других существ. Не повторяй ни этих фраз, ни их тем: ${told.map(x => `«${x.slice(0, 70)}»`).join(', ')}.` : '',
    ];
}

/** Where the talk stands in its plan, or, at the start, a request to make one up. */
function planPrompt(mind: CreatureMind, plan: TalkPlan | null, replies: number): string[] {
    if (!plan) {
        const lean = temperament(mind);
        const liked = BEATS.filter(b => b !== 'trouble').sort((a, b) => lean[b] - lean[a]).slice(0, 3);
        return [
            `Это начало разговора. Сначала придумай его порядок — только свой, непохожий на обычный: от ${PLAN_MIN} до ${PLAN_MAX} шагов после приветствия.`,
            `Виды шагов: ${BEATS.map(b => `"${b}" (${BEAT_RU[b]})`).join(', ')}. Ровно один шаг — "trouble"; сразу после последнего шага ты дашь поручение.`,
            `По характеру тебе ближе всего: ${liked.map(b => BEAT_RU[b]).join(', ')}.`,
            'Порядок верни в поле "plan": [{"beat": "вид шага", "topic": "о чём именно, 3–8 слов"}, …]. Сейчас твоя реплика — приветствие.',
        ];
    }
    const list = plan.beats.map((b, k) => `${k + 1}. ${b}${plan.topics[k] ? ` — ${plan.topics[k]}` : ''}`).join('; ');
    if (replies > plan.beats.length) return [`Порядок этого разговора: ${list}. Все шаги пройдены: СЕЙЧАС обязательно дай поручение.`];
    const k = replies - 1;
    return [
        `Порядок этого разговора (он только твой и больше никогда не повторится): ${list}.`,
        `Сейчас шаг ${k + 1}: ${BEAT_RU[plan.beats[k]]}${plan.topics[k] ? ` — ${plan.topics[k]}` : ''}. Поручение — только после шага ${plan.beats.length}.`,
    ];
}

function systemPrompt(mind: CreatureMind, world: WorldBrief, plan: TalkPlan | null, replies: number, known: (x: string) => boolean, mem?: CreatureMemory, shared?: SharedMemory): string {
    const surface = world.surface;
    const where = surface
        ? [
            `Ты — ${mind.name}, ${mind.species}. Ты живёшь на поверхности тела «${surface.body}» в системе «${world.system}».`,
            'К тебе подошёл робот, которым управляет пилот-человек: его корабль сел неподалёку.',
        ]
        : [
            `Ты — ${mind.name}, ${mind.species}, живое существо в космической игре.`,
            `Ты обитаешь возле тела «${mind.home}» в системе «${world.system}». К тебе на маленьком корабле подлетел пилот-человек.`,
        ];
    const kinds = surface
        ? [
            'Поручение бывает таких типов:',
            `— "kill" здесь, на поверхности: уничтожить наземных врагов. enemy: ${surface.foes.map(f => `"${f}" (${GROUND_RU[f]})`).join(', ')}.`,
            `— "collect": собрать ${surface.item} здесь, на поверхности; count — 2–8.`,
            '— "kill" в космосе: enemy: "drone", "fighter", "crystal", "interceptor", "gunship" (1–2), "hive" (1), "leviathan" (1); body — у какого тела.',
            '— "reach": долететь до другого тела системы и осмотреть его.',
            `body — одно из: ${world.bodies.join(', ')} (для работы на поверхности — «${surface.body}»).`,
        ]
        : [
            'Поручение бывает двух типов:',
            '— "kill": уничтожить врагов. enemy: "drone" (дроны-разведчики), "fighter" (пиратские штурмовики), "crystal" (кристаллиды-тараны), "interceptor" (быстрые перехватчики), "gunship" (тяжёлые канонерки, 1–2), "hive" (улей, рождающий дронов, только 1), "leviathan" (космический левиафан, только 1).',
            '— "reach": долететь до тела и осмотреть его.',
            `body — одно из: ${world.bodies.join(', ')}.`,
        ];
    const opening = !plan;
    return [
        ...memoryPrompt(mem),
        ...where,
        `Характер: ${mind.persona}`,
        ...sharedPrompt(mind, world, known, shared),
        'Говори по-русски, от первого лица, в своём характере, живо и образно: 2–4 предложения. Каждая реплика — новая: ни одной фразы, которая уже звучала.',
        'Реагируй на тон и слова пилота. Шути, грусти, спорь — как подсказывает характер.',
        ...planPrompt(mind, plan, replies),
        ...kinds,
        'Отвечай ТОЛЬКО объектом JSON, без markdown и пояснений:',
        `{"line": "твоя реплика", "options": ["ответ 1", "ответ 2", "ответ 3", "ответ 4"], "quest": null${opening ? ', "plan": [{"beat": "…", "topic": "…"}]' : ''}}`,
        'options — четыре коротких (до 12 слов) разных по тону ответа пилота: дружелюбный, деловой, дерзкий, любопытный, именно в этом порядке; каждый раз новые, по смыслу твоей реплики, без шаблонов.',
        `Когда даёшь поручение, вместо null укажи: "quest": {"title": "…", "brief": "что и зачем сделать", "type": ${surface ? '"kill", "collect" или "reach"' : '"kill" или "reach"'}, "enemy": "…", "count": число, "body": "…", "reward": число 100–1500}`,
    ].filter(Boolean).join('\n');
}

/** Enemies on foot, for the model. */
const GROUND_RU: Record<GroundKind, string> = {
    skitter: 'скиттеры — быстрые кусачие многоножки-машины',
    sentinel: 'шагоходы-стражи с пушками, 1–4',
    wraith: 'призрачные охотники, парящие и стреляющие',
    brute: 'громилы — тяжёлые бронированные твари, 1–2',
};

async function callModel(a: ModelAccess, system: string, history: { role: 'user' | 'assistant'; content: string }[], signal: AbortSignal): Promise<string> {
    if (a.provider === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model)}:generateContent?key=${encodeURIComponent(a.key)}`, {
            method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
                generationConfig: { temperature: 1, responseMimeType: 'application/json' },
            }),
        });
        if (!res.ok) throw new Error(`Gemini ${res.status}`);
        const j = await res.json();
        return j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    }
    const base = a.provider === 'groq' ? 'https://api.groq.com/openai/v1' : a.baseUrl || 'https://openrouter.ai/api/v1';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${a.key}` };
    if (a.provider === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Potok Universe'; }
    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal, headers,
        body: JSON.stringify({
            model: a.model, temperature: 1, max_tokens: 900,
            messages: [{ role: 'system', content: system }, ...history],
            ...(a.provider === 'groq' ? { response_format: { type: 'json_object' } } : {}),
        }),
    });
    if (!res.ok) throw new Error(`${a.provider} ${res.status}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// What creatures say: the lines of the scripted conversation.
// ---------------------------------------------------------------------------

/**
 * The pilot's replies, generated afresh for every turn: for each step of the talk, a pool of
 * lines per tone — friendly, business-like, rude, curious (always in that order, which is how the
 * creature reads the tone). {n} is the creature's name, {h} where it lives.
 */
const REPLY_POOLS: string[][][] = [
    [
        ['Рад встрече! Я пилот, лечу мимо.', 'Привет, {n}! Какая встреча.', 'Здравствуй! Мне говорили, у {h} живут удивительные существа.', 'Мир тебе. Я с миром.', 'Приятно познакомиться, {n}.'],
        ['Мне сказали, тут есть работа.', 'Я по делу. Найдётся заказ?', 'Коротко: мне нужны кредиты.', 'Пилот на свободном контракте. Слушаю.', 'Времени мало — что у тебя?'],
        ['Прочь с дороги, чудище.', 'Ещё один болтун на моём пути.', 'Не мешай, я занят.', 'Ты кто такой, чтобы меня останавливать?', 'Говори быстро, мне некогда.'],
        ['Кто ты такое?', 'Ого! А ты вообще живой?', 'Как тебя сюда занесло?', 'Никогда не видел таких, как ты. Расскажешь?', 'Ты здесь один(одна)?'],
    ],
    [
        ['Как красиво ты говоришь. Продолжай.', 'Удивительно! Никогда такого не слышал.', 'Спасибо, что делишься этим.', 'Мне нравится тебя слушать.', 'Это трогательно.'],
        ['Интересно, но ближе к делу.', 'Понятно. А что сейчас важнее всего?', 'Любопытно. Перейдём к сути?', 'Запомню. Что дальше?', 'Хорошо. И к чему ты ведёшь?'],
        ['Мне некогда слушать сказки.', 'Скучно.', 'Сочиняешь на ходу?', 'И зачем мне это знать?', 'Ну и что?'],
        ['Расскажи ещё — как ты здесь живёшь?', 'А что было дальше?', 'Как давно это было?', 'А другие такие же, как ты, есть?', 'Что ты ешь? Чем дышишь?'],
    ],
    [
        ['Я исследую Вселенную — хочу увидеть всё.', 'Ищу место, которое назову домом.', 'Лечу, потому что не могу иначе.', 'Меня ждут дома, но я обещал(а) вернуться с историями.', 'Хочу найти друзей среди звёзд.'],
        ['Я наёмный пилот, работаю за награду.', 'Коплю на новый двигатель.', 'Выполняю контракты, вот и всё.', 'Разведка и доставка — моя работа.', 'Плачу долги, беру заказы.'],
        ['Не твоё дело, куда я лечу.', 'Много будешь знать — скоро состаришься.', 'Отстань с вопросами.', 'Это секрет.', 'Сначала ты ответь.'],
        ['А почему ты спрашиваешь?', 'А ты сам(а) о чём мечтаешь?', 'Трудный вопрос. А у тебя есть ответ?', 'Хочешь, расскажу про Землю?', 'Интересно, что ты об этом думаешь?'],
    ],
    [
        ['Слухи? Люблю слухи, рассказывай.', 'Спасибо, что предупредил(а).', 'Буду осторожен(на). Что ещё слышно?', 'Ты много знаешь. Это ценно.', 'Звучит тревожно. Могу помочь?'],
        ['Слухи меня не кормят.', 'А за эту информацию платят?', 'Где именно это было?', 'Сколько их там?', 'Откуда эти сведения?'],
        ['Враньё это всё.', 'Сплетни.', 'Меня этим не напугать.', 'Я и не таких видел.', 'Сказки для новичков.'],
        ['А кто ещё живёт в этой системе?', 'А сам(а) ты это видел(а)?', 'Что там на самом деле?', 'Почему никто не разобрался?', 'А раньше такое бывало?'],
    ],
    [
        ['Я помогу. Что нужно сделать?', 'Для тебя — всё что угодно.', 'Не переживай, справлюсь.', 'Можешь на меня рассчитывать.', 'Скажи, чем помочь.'],
        ['Какая награда?', 'Сколько заплатишь?', 'Условия?', 'Что я получу взамен?', 'Сроки и оплата?'],
        ['С чего бы мне рисковать ради тебя?', 'Сам(а) разбирайся.', 'Не моя проблема.', 'Может, и помогу. Если захочу.', 'Опять кому-то что-то нужно.'],
        ['Кто эти враги и откуда они?', 'Почему именно я?', 'А что будет, если не помочь?', 'Давно это началось?', 'Кто ещё знает об этом?'],
    ],
    [
        ['Никогда об этом не думал(а). Спасибо!', 'Как красиво устроен твой мир.', 'Ты знаешь свой дом лучше любого атласа.', 'Запишу в бортовой журнал.', 'Вот это да. Хорошо, что я тебя встретил(а).'],
        ['Полезно для навигации.', 'Учту при посадке.', 'Это меняет расчёт маршрута.', 'Хорошо. Что ещё важно знать здесь?', 'Принято. Дальше?'],
        ['Это есть в любом справочнике.', 'Я и без тебя знал(а).', 'Лекции мне не нужны.', 'Скукота. Цифры, цифры.', 'И что мне с этого?'],
        ['А как ты это узнал(а)?', 'А тебе самому(самой) это не мешает жить?', 'А раньше здесь было иначе?', 'Откуда это известно — ты измерял(а)?', 'А что ещё здесь необычного?'],
    ],
    [
        ['Приятно, что обо мне говорят.', 'Передай им привет от меня.', 'Я стараюсь помогать, где могу.', 'Спасибо, что рассказал(а).', 'Хорошо, когда тебя помнят.'],
        ['Репутация — тоже валюта.', 'Значит, обо мне уже знают. Удобно.', 'Кто ещё это слышал?', 'Для дела это полезно.', 'Слухи — не контракт, но пусть.'],
        ['Пусть болтают что хотят.', 'Мне всё равно, что обо мне думают.', 'Сплетники вы тут все.', 'А тебе-то что?', 'Не твоё дело, что я делаю.'],
        ['А кто тебе это рассказал?', 'И что обо мне говорят ещё?', 'Вы тут все друг с другом знакомы?', 'Как вести так быстро долетают?', 'А ты сам(а) что об этом думаешь?'],
    ],
];

/** How the creature takes each tone, several ways each. */
const REACTIONS = [
    ['Твой голос тёплый, как свет близкой звезды.', 'Ты добр, пилот. Это редкость между орбитами.', 'Как приятно слышать доброе слово.', 'Ты мне нравишься, пилот.', 'С тобой легко говорить.', 'Твоя вежливость согревает.'],
    ['Деловой… Хорошо, у меня тоже мало времени.', 'Прямо к сути — уважаю.', 'Сразу видно профессионала.', 'Понимаю, дела прежде всего.', 'Ладно, без лишних слов.'],
    ['Дерзость — роскошь для того, кто летает в консервной банке.', 'Грубиян. Но смелый грубиян.', 'Хм. Не очень-то вежливо.', 'Ты всегда такой колючий?', 'Я прощу — на первый раз.', 'Острый язык, пилот.'],
    ['Любопытство — лучшее, что есть в вас, двуногих.', 'Ты задаёшь хорошие вопросы.', 'О, тебе правда интересно!', 'Любознательность — это прекрасно.', 'Какой любопытный гость!'],
];

/** Stories any creature may tell once its own are used up. */
const STORIES = [
    'Однажды мимо пролетал корабль, весь в огнях, как праздник. Он даже не притормозил. Ты — первый, кто остановился.',
    'Я видел(а), как звезда на миг погасла — что-то большое прошло перед ней. Не планета. Что-то живое.',
    'Здесь время течёт иначе: день длиннее, ночь тише. Я научился(ась) слушать тишину.',
    'Когда-то я пыталась(пытался) сосчитать все звёзды на небе. На третьем миллионе сбилась(сбился) и начала(начал) заново.',
    'У меня был друг, похожий на тебя — тоже всё время куда-то спешил. Однажды улетел и не вернулся.',
    'Самое красивое здесь — рассвет. Свет сначала синий, потом золотой, потом обычный. Жаль, это всего минута.',
    'Мне снится один и тот же сон: огромный город из стекла, и в каждом окне — чья-то жизнь.',
    'Здесь бывают бури, от которых дрожит сама земля. Мы прячемся и ждём, пока утихнет.',
    'Я храню камешек с другой планеты. Не знаю, откуда он. Просто однажды он упал с неба прямо мне в руки.',
    'Иногда ночью над горизонтом пролетают огни. Не корабли — они движутся слишком странно.',
];

/** Questions any creature may ask, besides its own. */
const QUESTIONS = [
    'А какая у тебя самая красивая планета из виденных?',
    'Ты когда-нибудь боялся(ась) темноты между звёздами?',
    'Что ты возьмёшь с собой, если придётся бежать навсегда?',
    'Правда, что на Земле вода падает прямо с неба?',
    'У тебя есть имя, или только позывной?',
    'Ты веришь, что звёзды живые?',
    'Сколько тебе лет по вашему счёту?',
    'Чего тебе не хватает в полёте больше всего?',
];

/** Gossip any creature may pass on. */
const RUMORS = [
    'Говорят, за орбитой Нептуна кто-то зажёг портал, и из него до сих пор тянет холодом чужой галактики.',
    'Пираты прячут добычу в тени спутников — там их не видят ни радары, ни звёзды.',
    'Левиафаны поют перед охотой. Если услышишь низкий гул — поворачивай.',
    'Кристаллиды рождаются из обломков разбитых кораблей. Поэтому их всё больше.',
    'Где-то в поясе астероидов лежит станция без экипажа, и её огни всё ещё мигают.',
    'В центре галактики чёрная дыра хранит память всего, что в неё упало. Так шепчут оракулы.',
    'Кто-то видел корабль, который летел задом наперёд во времени. Он приземлился вчера — завтра.',
    'На одной луне нашли следы. Не наши, не ваши. Шесть пальцев, и все босые.',
    'Говорят, если пролететь сквозь хвост кометы на форсаже, двигатель запоёт.',
    'Скиттеры собираются в стаи, когда чувствуют железо. А ты весь из железа, дружок.',
    'Старые маяки на краю системы снова включились. Никто не знает, кто их питает.',
    'Шагоходы-стражи охраняют что-то под землёй. Что — никто не вернулся рассказать.',
];

/** Lines any creature may make its own: {h} is its home, {b} another world of its system. */
const DREAMS = [
    'Мне снится, что я лечу над миром «{b}», и внизу не камни, а музыка.',
    'Я мечтаю однажды увидеть мир «{b}» вблизи — говорят, оттуда наш дом кажется искрой.',
    'Иногда я представляю, что вся наша система — один огромный организм, а мы его мысли.',
    'Мне снилось, что звёзды погасли и остался только наш свет. Было не страшно — тихо.',
    'Я мечтаю построить дом в мире «{b}». Небольшой, но с окном на звезду.',
    'Во сне я разговариваю с кометами. Они торопятся и отвечают невпопад.',
    'Хочу когда-нибудь уйти за край нашей системы и посмотреть, что за ним.',
    'Мне приснился пилот, похожий на тебя. Он вёз груз из песен.',
];
const CONFESSIONS = [
    'Скажу тебе то, чего не говорил(а) никому: я боюсь тишины между звёздами.',
    'Признаюсь: однажды я спрятал(а) обломок чужого корабля и никому его не отдал(а).',
    'Честно? Я давно хочу улететь отсюда, но не знаю куда.',
    'Когда мимо летят пираты, я иногда притворяюсь спящим(ей). Это трусость?',
    'Моя тайна: я считаю корабли, что пролетают мимо мира «{b}». Ты — особенный номер.',
    'Я завидую тем, кто живёт в мире «{b}». Глупо, правда?',
    'Когда-то я солгал(а) другу, и он улетел. С тех пор я говорю только правду.',
    'Я не помню, сколько мне лет: перестал(а) считать после третьей вспышки звезды.',
];
const JOKES = [
    'Знаешь, почему пираты не летают к миру «{b}»? Там даже эхо требует плату.',
    'Сколько пилотов нужно, чтобы поменять лампочку в шлюзе? Ни одного: они включают автопилот и ждут.',
    'Дрон спрашивает кристаллида: «Ты чего такой острый?» А тот: «Я просто в форме».',
    'Говорят, в нашей системе такой вакуум, что шутки не долетают. Эта, кажется, долетела.',
    'Я пробовал(а) обидеться на звезду. Она не заметила. Звёзды вообще не замечают обид.',
    'У левиафана спросили, зачем он поёт. Он ответил: «Чтобы все знали, куда не лететь».',
    'Один робот так долго шёл по миру «{b}», что успел устареть по дороге.',
    '«Всё под контролем», — сказал пилот за секунду до посадки на газовый гигант.',
];
const COMPLAINTS = [
    'Здесь бывает так холодно, что мысли замерзают на полпути.',
    'Шумно стало: дроны гудят день и ночь, никакого покоя.',
    'Корабли летают всё быстрее, и никто не останавливается поздороваться. Кроме тебя.',
    'Свет звезды здесь то слишком яркий, то слишком слабый. Никакого постоянства.',
    'Пыль, пыль, пыль. Я уже забыл(а), какого цвета я на самом деле.',
    'Соседи из мира «{b}» опять шлют помехи в эфир. Невыносимо.',
    'Никто здесь больше не читает звёзды вслух. А раньше читали.',
    'Мне не хватает собеседников. С камнями разговор короткий.',
];
const TROUBLE_AGAIN = [
    'А беда моя никуда не делась — стало только хуже.',
    'Помнишь, я говорил(а) о своей беде? Она вернулась.',
    'У меня снова тревога, пилот, и без тебя опять не справиться.',
    'Опять здесь неспокойно, и я не знаю, к кому ещё обратиться.',
    'Я думал(а), всё позади. Но нет — всё началось заново.',
    'Прошлый раз помог ненадолго. Они вернулись, и их больше.',
    'Даже в мире «{b}» уже слышали о моей беде, а помощи всё нет.',
    'Весь эфир отсюда до мира «{b}» гудит тревогой — и моя беда в нём громче всех.',
    'Я посылал(а) зов к миру «{b}», но никто не прилетел. Только ты.',
    'Ночами я смотрю в сторону мира «{b}» и жду, откуда придёт следующая напасть.',
];
const FACT_FRAMES = [
    'А знаешь, что здесь правда?', 'Я долго смотрю на небо, и вот что знаю наверняка.', 'Спроси любого из местных — подтвердит.',
    'Этому меня научили старшие.', 'Удивительно, но это так.', 'Запомни, пригодится в полёте.',
    'Вот тебе настоящая правда о нашем мире.', 'Смешно, но многие пилоты этого не знают.',
];
const DEED_FRAMES = [
    'До меня дошли вести: ты {d}.', 'Весь эфир гудит — говорят, ты {d}.', 'Мне рассказали, что ты {d}. Это правда?',
    'Кометы принесли новость: ты {d}.', 'Я слышал(а), ты {d}. Такое здесь не забывают.', 'О тебе говорят: ты {d}. Я запомнил(а).',
];
const GOSSIP_FRAMES = [
    'Мы тут, между орбитами, всё друг другу рассказываем.', 'Слухи летят быстрее кораблей.', 'Знаешь, о тебе уже говорят.',
    'Я тут кое с кем перекинулся(ась) парой слов.', 'Эфир маленький, все всех слышат.',
];

/** Shuffled but repeatable: a pick from a list for this talk. */
function choose<T>(list: T[], seed: number, avoid: (x: T) => boolean = () => false): T {
    const n = list.length;
    const start = Math.abs(Math.floor(seed * 2654435761)) % n;
    for (let k = 0; k < n; k++) {
        const x = list[(start + k * 7) % n];
        if (!avoid(x)) return x;
    }
    return list[start];
}

const fill = (line: string, mind: CreatureMind) => line.replace(/\{n\}/g, mind.name.split(' ').pop() ?? mind.name).replace(/\{h\}/g, mind.home);

/** Four fresh replies for this step of the talk, one of each tone. */
export function replyOptions(mind: CreatureMind, step: number, seed: number): string[] {
    const pools = REPLY_POOLS[Math.min(step, REPLY_POOLS.length - 1)];
    return pools.map((pool, tone) => fill(choose(pool, seed * 31 + tone * 101 + step * 7), mind));
}

// ---------------------------------------------------------------------------
// The order of a talk: each creature's own, never used twice.
// ---------------------------------------------------------------------------

/** What one turn of a talk is about. */
export type Beat = 'story' | 'question' | 'rumor' | 'fact' | 'deed' | 'gossip' | 'dream' | 'confession' | 'joke' | 'complaint' | 'trouble';
export const BEATS: Beat[] = ['story', 'question', 'rumor', 'fact', 'deed', 'gossip', 'dream', 'confession', 'joke', 'complaint', 'trouble'];

const BEAT_RU: Record<Beat, string> = {
    story: 'история из своей жизни', question: 'вопрос пилоту о нём самом', rumor: 'слух о системе',
    fact: 'настоящий факт об этом мире', deed: 'что ты слышал(а) о делах пилота', gossip: 'что о пилоте говорят другие существа',
    dream: 'мечта или сон', confession: 'признание, тайна', joke: 'шутка или байка', complaint: 'жалоба на жизнь здесь',
    trouble: 'беда, из-за которой нужна помощь пилота',
};

/** Which pool of the pilot's replies suits each kind of turn. */
const BEAT_REPLIES: Record<Beat, number> = {
    story: 1, dream: 1, confession: 1, joke: 1, complaint: 1, question: 2, rumor: 3, fact: 5, deed: 6, gossip: 6, trouble: 4,
};

export interface TalkPlan {
    /** The turns after the greeting, in order; the errand comes right after the last. */
    beats: Beat[];
    /** What each is about, as the model put it ('' where the game chose). */
    topics: string[];
}

/** Turns in a plan: the errand then comes after MIN_REPLIES…MAX_REPLIES of the pilot's replies. */
const PLAN_MIN = MIN_REPLIES - 1, PLAN_MAX = MAX_REPLIES - 1;

/** A plan's order, as the world remembers it. */
export const orderOf = (p: TalkPlan) => p.beats.join('>');

const nameSeed = (s: string) => [...s].reduce((h, c) => hash32(h, c.charCodeAt(0)), 0x5eed);

/** What a creature likes to talk about, from its name: every creature leans its own way. */
export function temperament(mind: CreatureMind): Record<Beat, number> {
    const rng = mulberry32(nameSeed(mind.name));
    const w = {} as Record<Beat, number>;
    for (const b of BEATS) w[b] = b === 'trouble' ? 0 : 0.15 + 2 * rng() ** 2;
    return w;
}

/** Kinds of turn there is something for at all (the same for the whole talk). */
function topicsAvailable(mind: CreatureMind, world?: WorldBrief, shared?: SharedMemory): Beat[] {
    return BEATS.filter(b => b !== 'trouble'
        && (b !== 'fact' || !!world?.facts?.length)
        && (b !== 'deed' || deedsOf(shared, mind).length > 0)
        && (b !== 'gossip' || others(mind, shared).length > 0));
}

function weighted(kinds: Beat[], lean: Record<Beat, number>, rng: () => number): Beat {
    let x = rng() * kinds.reduce((a, k) => a + lean[k], 0);
    for (const k of kinds) if ((x -= lean[k]) <= 0) return k;
    return kinds[kinds.length - 1];
}

/** A kind for turn i that differs from its neighbours and is not used twice already. */
function fitting(beats: Beat[], i: number, kinds: Beat[]): Beat[] {
    const ok = kinds.filter(k => k !== beats[i - 1] && k !== beats[i + 1] && beats.filter((x, j) => x === k && j !== i).length < 2);
    return ok.length ? ok : kinds;
}

/**
 * The game's own plan for a talk, after the creature's leanings, unlike any order used before.
 * Repeatable for the same creature, talk and world memory.
 */
export function planTalk(mind: CreatureMind, memory?: CreatureMemory, shared?: SharedMemory, world?: WorldBrief): TalkPlan {
    const used = new Set(shared?.world.orders ?? []);
    const lean = temperament(mind);
    const kinds = topicsAvailable(mind, world, shared);
    const rng = mulberry32(hash32(nameSeed(mind.name), memory?.talks ?? 0, used.size));
    let beats: Beat[] = [];
    for (let attempt = 0; attempt < 500; attempt++) {
        const n = PLAN_MIN + Math.floor(rng() * (PLAN_MAX - PLAN_MIN + 1));
        // The trouble comes late more often than early, but may come anywhere.
        const at = n - 1 - Math.floor(rng() * rng() * n);
        beats = [];
        for (let i = 0; i < n; i++) beats.push(i === at ? 'trouble' : weighted(fitting(beats, i, kinds), lean, rng));
        if (!used.has(beats.join('>'))) break;
    }
    return { beats, topics: beats.map(() => '') };
}

/** Read the plan a model proposed; null if there is none worth keeping. */
export function parsePlan(raw: string): TalkPlan | null {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let list: unknown;
    try { list = (JSON.parse(raw.slice(start, end + 1)) as { plan?: unknown }).plan; } catch { return null; }
    if (!Array.isArray(list)) return null;
    const beats: Beat[] = [], topics: string[] = [];
    for (const x of list) {
        const o = (typeof x === 'string' ? { beat: x } : x) as { beat?: unknown; topic?: unknown } | null;
        const b = typeof o?.beat === 'string' ? o.beat.trim().toLowerCase() : '';
        if (!BEATS.includes(b as Beat)) continue;
        beats.push(b as Beat);
        topics.push(typeof o?.topic === 'string' ? o.topic.trim().slice(0, 80) : '');
    }
    if (beats.length < 2) return null;
    // Exactly one trouble: the last one the model named, or a new last turn.
    const last = beats.lastIndexOf('trouble');
    for (let i = beats.length - 1; i >= 0; i--) if (beats[i] === 'trouble' && i !== last) { beats.splice(i, 1); topics.splice(i, 1); }
    if (last < 0) { beats.push('trouble'); topics.push(''); }
    while (beats.length > PLAN_MAX) {
        const i = beats.findIndex(b => b !== 'trouble');
        beats.splice(i, 1); topics.splice(i, 1);
    }
    return { beats, topics };
}

/**
 * Make a plan's order one never used before: pad a short one, then change single turns
 * (never the trouble) until it is new. Topics of changed turns are dropped.
 */
export function uniquePlan(plan: TalkPlan, mind: CreatureMind, shared?: SharedMemory, world?: WorldBrief): TalkPlan {
    const used = new Set(shared?.world.orders ?? []);
    const kinds = topicsAvailable(mind, world, shared);
    const lean = temperament(mind);
    const beats = [...plan.beats], topics = [...plan.topics];
    const rng = mulberry32(hash32(nameSeed(mind.name), used.size, beats.length));
    while (beats.length < PLAN_MIN) {
        const i = Math.floor(rng() * beats.length);
        beats.splice(i, 0, weighted(fitting(beats, i, kinds), lean, rng));
        topics.splice(i, 0, '');
    }
    for (let attempt = 0; attempt < 500 && used.has(beats.join('>')); attempt++) {
        const free = beats.map((b, i) => (b === 'trouble' ? -1 : i)).filter(i => i >= 0);
        const i = free[Math.floor(rng() * free.length)];
        if (beats.length < PLAN_MAX && rng() < 0.3) {
            beats.splice(i, 0, weighted(fitting(beats, i, kinds), lean, rng));
            topics.splice(i, 0, '');
        } else {
            beats[i] = weighted(fitting(beats, i, kinds), lean, rng);
            topics[i] = '';
        }
    }
    return { beats, topics };
}

// ---------------------------------------------------------------------------
// The scripted conversation: memory, mood, and each turn by the plan.
// ---------------------------------------------------------------------------

/** How the pilot's reply shifts the creature's mood: options come friendly, business, rude, curious. */
export const TONE_MOOD = [1, 0, -1, 0.5];

/** Mood in words, for the model. */
const moodText = (m: number) => m >= 2 ? 'очень тёплое, ты рада(рад) пилоту' : m >= 0.5 ? 'доброе' : m > -0.5 ? 'нейтральное' : m > -2 ? 'настороженное, пилот бывал груб' : 'обиженное';

/** The first words to a pilot met before, from what the creature remembers. */
export function memoryGreeting(mem: CreatureMemory): string {
    const last = mem.errands[mem.errands.length - 1];
    const parts: string[] = [];
    if (last?.state === 'done') parts.push(`Ты вернулся! Я не забыла, как ты справился с «${last.title}». Спасибо.`);
    else if (last?.state === 'failed') parts.push(`Помню, «${last.title}» у тебя тогда не вышло. Ничего, бывает.`);
    else if (mem.mood >= 1) parts.push('Рада снова видеть тебя, пилот!');
    else if (mem.mood <= -1) parts.push('А, это ты… В прошлый раз ты был не слишком вежлив.');
    else parts.push('Снова ты? Мы ведь уже говорили — помнишь?');
    const said = mem.said[mem.said.length - 1];
    if (said) parts.push(`Ты тогда сказал: «${said}».`);
    parts.push('О чём поговорим на этот раз?');
    return parts.join(' ');
}

/** Hurt enough, a creature will not talk until the pilot apologises. */
export const REFUSE_MOOD = -2.5;
export const APOLOGY = 'Прости, я был груб.';

/** What a scripted talk draws on besides the creature itself. */
export interface TalkContext {
    plan?: TalkPlan;
    world?: WorldBrief;
    shared?: SharedMemory;
}

/** Was this said already: in this talk, to this pilot before, or by anyone in the world. */
function knownTo(history: Exchange[], memory?: CreatureMemory, shared?: SharedMemory): (x: string) => boolean {
    return x => history.some(h => h.turn.line.includes(x)) || !!memory?.told?.some(t => t.includes(x)) || !!shared?.world.told.some(t => t.includes(x));
}

/** A line of one kind that nobody has heard yet, or null if there is none left. */
function beatLine(beat: Beat, mind: CreatureMind, known: (x: string) => boolean, seed: number, world?: WorldBrief, shared?: SharedMemory): string | null {
    const sc = mind.script;
    const rng = mulberry32(seed);
    const fresh = (list: string[]) => {
        const left = list.filter(x => !known(x));
        return left.length ? left[Math.floor(rng() * left.length)] : null;
    };
    const elsewhere = (world?.bodies ?? []).filter(b => b !== mind.home);
    // Templates filled in every way this system allows: one not used at all comes first,
    // and a template comes back (about another world) only when all of them have been used.
    const filled = (list: string[]) => {
        const ways = list.map(t => {
            const base = t.replace(/\{h\}/g, mind.home);
            const all = base.includes('{b}') ? elsewhere.map(b => base.replace(/\{b\}/g, b)) : [base];
            return { all, left: all.filter(x => !known(x)) };
        }).filter(w => w.left.length);
        const unused = ways.filter(w => w.left.length === w.all.length);
        const pool = unused.length ? unused : ways;
        return pool.length ? fresh(pool[Math.floor(rng() * pool.length)].left) : null;
    };
    const frame = (frames: string[]) => frames[Math.floor(rng() * frames.length)];
    switch (beat) {
        case 'story': return (!known(sc.lore[0]) ? sc.lore.find(l => !known(l)) : null) ?? fresh(sc.lore) ?? fresh(STORIES);
        case 'question': return (!known(sc.ask) ? sc.ask : null) ?? fresh(QUESTIONS);
        case 'rumor': {
            const r = fresh(RUMORS);
            return r ? `${known(sc.rumor) ? '' : sc.rumor + ' '}${r}` : null;
        }
        case 'fact': {
            const f = freshFacts(world ?? { system: '', bodies: [] }, mind.home, known, seed)[0];
            return f ? `${frame(FACT_FRAMES)} ${f}` : null;
        }
        case 'deed': {
            const d = deedsOf(shared, mind).find(x => !known(x));
            return d ? frame(DEED_FRAMES).replace('{d}', d) : null;
        }
        case 'gossip': {
            const g = fresh(gossipOf(mind, shared));
            return g ? `${frame(GOSSIP_FRAMES)} ${g}` : null;
        }
        case 'dream': return filled(DREAMS);
        case 'confession': return filled(CONFESSIONS);
        case 'joke': return filled(JOKES);
        case 'complaint': return filled(COMPLAINTS);
        case 'trouble': return (!known(sc.trouble) ? sc.trouble : null) ?? filled(TROUBLE_AGAIN) ?? sc.trouble;
    }
}

/** The next turn of the scripted talk, given what was said so far. */
export function scriptedTurn(mind: CreatureMind, history: Exchange[], memory?: CreatureMemory, ctx: TalkContext = {}): DialogueTurn {
    const r = history.length; // the pilot has answered every turn shown so far
    const plan = ctx.plan ?? planTalk(mind, memory, ctx.shared, ctx.world);
    // Every talk is its own: the lines and the replies offered depend on how many talks came before.
    const talkSeed = (memory?.talks ?? 0) * 977 + [...mind.name].reduce((a, c) => a + c.charCodeAt(0), 0) + (ctx.shared?.world.told.length ?? 0) * 131;
    const seed = talkSeed + r * 13;
    const prev = r ? history[r - 1] : null;
    const last = prev?.reply ?? '';
    const tone = prev ? prev.turn.options.indexOf(last) : -1;
    const said = history.map(h => h.turn.line);
    const known = knownTo(history, memory, ctx.shared);
    // A word on the pilot's tone, now and then: one not heard before if there is one, never one from this talk.
    const heard = (x: string) => said.some(l => l.startsWith(x));
    const pool = tone >= 0 && tone < 4 ? REACTIONS[tone].filter(x => !heard(x)) : [];
    const react = pool.length && (r > plan.beats.length || mulberry32(seed)() < 0.6) ? choose(pool, seed, known) + ' ' : '';
    const opts = (step: number) => replyOptions(mind, step, seed);
    if (r === 0) return { line: memory && memory.talks > 1 ? memoryGreeting(memory) : mind.script.greet, options: opts(0), quest: null };
    if (r <= plan.beats.length) {
        const beat = plan.beats[r - 1];
        // Nothing new of this kind left: the creature talks of what it has not told yet, as it leans.
        const lean = temperament(mind);
        const instead = BEATS.filter(b => b !== beat && b !== 'trouble').sort((a, b) => lean[b] - lean[a]);
        let line: string | null = null, used: Beat = beat;
        for (const b of [beat, ...instead]) {
            line = beatLine(b, mind, known, seed, ctx.world, ctx.shared);
            if (line) { used = b; break; }
        }
        line ??= choose(STORIES, seed, l => said.some(x => x.includes(l)));
        if (memory) memory.told = [...(memory.told ?? []), line].slice(-30);
        return { line: react + line, options: opts(BEAT_REPLIES[used]), quest: null };
    }
    const w = mind.wish;
    const quest: QuestOffer = { ...w, brief: w.why };
    const line = (tone === 2 ? 'Дерзко — но ты мне подходишь. ' : tone === 1 ? 'Награда будет. ' : react) + w.why;
    return { line, options: [ACCEPT, DECLINE], quest };
}

/** Much the same words as a line already said (the model repeating itself or another creature). */
export function repeats(line: string, before: string[]): boolean {
    const words = (x: string) => new Set(x.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2));
    const a = words(line);
    if (a.size < 3) return before.includes(line);
    return before.some(b => {
        const c = words(b);
        let common = 0;
        for (const w of a) if (c.has(w)) common++;
        return common / (a.size + c.size - common) >= 0.6;
    });
}

// ---------------------------------------------------------------------------
// A conversation.
// ---------------------------------------------------------------------------

export class Conversation {
    readonly history: Exchange[] = [];
    readonly access = modelAccess();
    /** Set once the model failed; the rest of the talk is scripted. */
    offline = !this.access;
    /** The order of this talk; the model makes it up in its first reply, or the game does. */
    plan: TalkPlan | null = null;
    private abort = new AbortController();
    /** Tones the pilot has shown this talk (the world hears of the first rude or kind word). */
    private shown = new Set<number>();

    constructor(readonly mind: CreatureMind, readonly world: WorldBrief, readonly memory?: CreatureMemory, readonly shared?: SharedMemory) {
        if (memory) memory.name = mind.name;
        if (this.offline) this.settle(planTalk(mind, memory, shared, world));
    }

    get current(): DialogueTurn | null { return this.history[this.history.length - 1]?.turn ?? null; }

    /** The creature's first words. */
    open(): Promise<DialogueTurn> { return this.advance(); }

    /** The pilot answers the current turn; returns the creature's next one. */
    answer(reply: string): Promise<DialogueTurn> {
        const cur = this.history[this.history.length - 1];
        if (cur) {
            cur.reply = reply;
            // The creature remembers what was said, and how.
            const tone = cur.turn.options.indexOf(reply);
            if (this.memory) {
                if (tone >= 0 && tone < 4) this.memory.mood = Math.max(-3, Math.min(3, this.memory.mood + TONE_MOOD[tone] * 0.5));
                this.memory.said = [...this.memory.said, reply].slice(-6);
            }
            // And the others hear of it.
            if (this.shared && (tone === 0 || tone === 2) && !this.shown.has(tone)) {
                this.shown.add(tone);
                rememberDeed(this.shared.world, tone === 2 ? `нагрубил(а) существу по имени ${this.mind.name}` : `был(а) очень любезен(на) с существом по имени ${this.mind.name}`);
            }
        }
        return this.advance();
    }

    cancel() { this.abort.abort(); }

    /** Fix the talk's order: new to the world, and remembered so nobody uses it again. */
    private settle(plan: TalkPlan) {
        this.plan = uniquePlan(plan, this.mind, this.shared, this.world);
        if (this.shared) rememberOrder(this.shared.world, orderOf(this.plan));
    }

    private known = (x: string) => knownTo(this.history, this.memory, this.shared)(x);

    private async ask(system: string, msgs: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
        const timer = setTimeout(() => this.abort.abort(), 30_000);
        try {
            return await callModel(this.access!, system, msgs, this.abort.signal);
        } finally {
            clearTimeout(timer);
            if (this.abort.signal.aborted) this.abort = new AbortController();
        }
    }

    private async advance(): Promise<DialogueTurn> {
        const replies = this.history.length;
        let turn: DialogueTurn | null = null;
        if (!this.offline && this.access) {
            const opening = this.world.surface ? '(Робот пилота подходит к тебе и ждёт. Начни разговор.)' : '(Пилот подлетает к тебе и ждёт. Начни разговор.)';
            const msgs: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: opening }];
            for (const h of this.history) {
                msgs.push({ role: 'assistant', content: JSON.stringify(h.turn) });
                if (h.reply) msgs.push({ role: 'user', content: h.reply });
            }
            try {
                const system = systemPrompt(this.mind, this.world, this.plan, replies, this.known, this.memory, this.shared);
                let raw = await this.ask(system, msgs);
                turn = parseTurn(raw, this.world, this.mind);
                // Said before, by this creature or another: once more, asking for something new.
                const before = [...(this.shared?.world.told ?? []), ...this.history.map(h => h.turn.line)];
                if (turn && replies > 0 && repeats(turn.line, before)) {
                    const again = await this.ask(system, [...msgs, { role: 'assistant', content: raw }, { role: 'user', content: '(Это уже звучало раньше. Скажи что-то совсем новое, по своему шагу.)' }]);
                    const t2 = parseTurn(again, this.world, this.mind);
                    if (t2 && !repeats(t2.line, before)) { turn = t2; raw = again; }
                }
                if (turn && !this.plan) this.settle(parsePlan(raw) ?? planTalk(this.mind, this.memory, this.shared, this.world));
                // Too eager: keep talking a little longer before the errand.
                if (turn?.quest && replies < MIN_REPLIES) {
                    turn = { line: turn.line, options: ['Расскажи сначала о себе.', 'Что за работа?', 'Не торопись, я слушаю.', 'Откуда ты это знаешь?'], quest: null };
                }
            } catch (err) {
                console.warn('creature dialogue: model unavailable, using the script', err);
                turn = null;
            }
            if (!turn) this.offline = true;
        }
        if (!this.plan) this.settle(planTalk(this.mind, this.memory, this.shared, this.world));
        // The model sometimes never gets round to it; past the limit the creature's own wish stands.
        if (turn && !turn.quest && replies >= MAX_REPLIES) {
            const w = this.mind.wish;
            turn = { line: turn.line + ' ' + w.why, options: [ACCEPT, DECLINE], quest: { ...w, brief: w.why } };
        }
        if (!turn) turn = scriptedTurn(this.mind, this.history, this.memory, { plan: this.plan!, world: this.world, shared: this.shared });
        else if (this.memory) this.memory.told = [...(this.memory.told ?? []), turn.line].slice(-30);
        if (this.shared) rememberTold(this.shared.world, turn.line);
        this.history.push({ turn });
        return turn;
    }
}
