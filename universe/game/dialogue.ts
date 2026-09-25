// Conversations with the creatures of space. A creature opens the talk, the
// pilot picks one of four replies, and it goes on until the creature hands
// out an errand. The lines come from the language model the pilot set up in
// Potok (their own key, from this browser's storage); without one, or when
// the model fails, the creature falls back on a scripted conversation.

import { secureStorage } from '../storage';
import type { EnemyKind } from './models';
import type { CreatureMemory } from './progress';
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

function systemPrompt(mind: CreatureMind, world: WorldBrief, forceQuest: boolean, mem?: CreatureMemory): string {
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
    return [
        ...memoryPrompt(mem),
        ...where,
        `Характер: ${mind.persona}`,
        'Говори по-русски, от первого лица, в своём характере, живо и образно: 2–4 предложения.',
        'Ты очень разговорчив(а): рассказываешь о себе и своей жизни, делишься слухами о системе и других существах,',
        'задаёшь пилоту вопросы о нём самом, шутишь или грустишь — как подсказывает характер. Реагируй на тон и слова пилота.',
        `Ты сама(сам) начинаешь разговор и постепенно ведёшь его к тому, чтобы дать пилоту поручение — не раньше ${MIN_REPLIES}-го ответа пилота.`,
        forceQuest ? 'СЕЙЧАС обязательно дай поручение.' : '',
        ...kinds,
        'Отвечай ТОЛЬКО объектом JSON, без markdown и пояснений:',
        '{"line": "твоя реплика", "options": ["ответ 1", "ответ 2", "ответ 3", "ответ 4"], "quest": null}',
        'options — четыре коротких (до 12 слов) разных по тону ответа пилота: дружелюбный, деловой, дерзкий, любопытный, именно в этом порядке; каждый раз новые, по смыслу твоей реплики, без шаблонов.',
        `Когда даёшь поручение, вместо null укажи: "quest": {"title": "…", "brief": "что и зачем сделать", "type": ${surface ? '"kill", "collect" или "reach"' : '"kill" или "reach"'}, "enemy": "…", "count": число, "body": "…", "reward": число 100–1500}`,
    ].join('\n');
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
                generationConfig: { temperature: 0.95, responseMimeType: 'application/json' },
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
            model: a.model, temperature: 0.95, max_tokens: 700,
            messages: [{ role: 'system', content: system }, ...history],
            ...(a.provider === 'groq' ? { response_format: { type: 'json_object' } } : {}),
        }),
    });
    if (!res.ok) throw new Error(`${a.provider} ${res.status}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// The scripted conversation.
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

const pick = <T>(list: T[], seed: number) => list[Math.abs(Math.floor(seed)) % list.length];

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

/** The next turn of the scripted talk, given what was said so far. */
export function scriptedTurn(mind: CreatureMind, history: Exchange[], memory?: CreatureMemory): DialogueTurn {
    const r = history.length; // the pilot has answered every turn shown so far
    // Every talk is its own: the lines and the replies offered depend on how many talks came before.
    const talkSeed = (memory?.talks ?? 0) * 977 + [...mind.name].reduce((a, c) => a + c.charCodeAt(0), 0);
    const seed = talkSeed + r * 13;
    const prev = r ? history[r - 1] : null;
    const last = prev?.reply ?? '';
    const tone = prev ? prev.turn.options.indexOf(last) : -1;
    const react = tone >= 0 && tone < 4 ? choose(REACTIONS[tone], seed) + ' ' : '';
    const said = history.map(h => h.turn.line);
    const told = (line: string) => said.some(x => x.includes(line)) || (memory?.told ?? []).includes(line);
    const sc = mind.script;
    // Stories not yet told — this talk or any before — come first.
    const own = sc.lore.filter(l => !told(l));
    const fresh = own.length ? own : STORIES.filter(l => !told(l));
    const story = fresh.length ? choose(fresh, seed) : choose(STORIES, seed, l => said.some(x => x.includes(l)));
    const remember = (line: string) => { if (memory) memory.told = [...(memory.told ?? []), line].slice(-12); };
    const rumor = sc.rumor + ' ' + choose(RUMORS, seed + 5, x => said.some(l => l.includes(x)) || (memory?.told ?? []).includes(x));
    const opts = (step: number) => replyOptions(mind, step, seed);
    if (r === 0) return { line: memory && memory.talks > 1 ? memoryGreeting(memory) : sc.greet, options: opts(0), quest: null };
    // A curious pilot keeps the stories coming (up to the limit).
    if (tone === 3 && fresh.length && r < MAX_REPLIES - 2 && r >= 3) {
        remember(story);
        return { line: react + story, options: opts(1), quest: null };
    }
    if (r === 1) { remember(story); return { line: react + story, options: opts(1), quest: null }; }
    if (r === 2) {
        const ask = (memory?.talks ?? 0) > 1 ? choose(QUESTIONS, seed) : sc.ask;
        return { line: react + ask, options: opts(2), quest: null };
    }
    if (r === 3) {
        const more = fresh.filter(l => l !== story);
        const extra = more.length ? choose(more, seed + 3) : '';
        if (extra) remember(extra);
        const gossip = rumor.slice(sc.rumor.length + 1);
        remember(gossip);
        return { line: react + (extra ? extra + ' ' : '') + rumor, options: opts(3), quest: null };
    }
    if (!told(sc.trouble) && r < MAX_REPLIES) return { line: react + sc.trouble, options: opts(4), quest: null };
    const w = mind.wish;
    const quest: QuestOffer = { ...w, brief: w.why };
    const line = (tone === 2 ? 'Дерзко — но ты мне подходишь. ' : tone === 1 ? 'Награда будет. ' : react) + w.why;
    return { line, options: [ACCEPT, DECLINE], quest };
}

// ---------------------------------------------------------------------------
// A conversation.
// ---------------------------------------------------------------------------

export class Conversation {
    readonly history: Exchange[] = [];
    readonly access = modelAccess();
    /** Set once the model failed; the rest of the talk is scripted. */
    offline = !this.access;
    private abort = new AbortController();

    constructor(readonly mind: CreatureMind, readonly world: WorldBrief, readonly memory?: CreatureMemory) {}

    get current(): DialogueTurn | null { return this.history[this.history.length - 1]?.turn ?? null; }

    /** The creature's first words. */
    open(): Promise<DialogueTurn> { return this.advance(); }

    /** The pilot answers the current turn; returns the creature's next one. */
    answer(reply: string): Promise<DialogueTurn> {
        const cur = this.history[this.history.length - 1];
        if (cur) {
            cur.reply = reply;
            // The creature remembers what was said, and how.
            if (this.memory) {
                const tone = cur.turn.options.indexOf(reply);
                if (tone >= 0 && tone < 4) this.memory.mood = Math.max(-3, Math.min(3, this.memory.mood + TONE_MOOD[tone] * 0.5));
                this.memory.said = [...this.memory.said, reply].slice(-6);
            }
        }
        return this.advance();
    }

    cancel() { this.abort.abort(); }

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
            const timer = setTimeout(() => this.abort.abort(), 30_000);
            try {
                const raw = await callModel(this.access, systemPrompt(this.mind, this.world, replies >= MAX_REPLIES, this.memory), msgs, this.abort.signal);
                turn = parseTurn(raw, this.world, this.mind);
                // Too eager: keep talking a little longer before the errand.
                if (turn?.quest && replies < MIN_REPLIES) {
                    turn = { line: turn.line, options: ['Расскажи сначала о себе.', 'Что за работа?', 'Не торопись, я слушаю.', 'Откуда ты это знаешь?'], quest: null };
                }
            } catch (err) {
                console.warn('creature dialogue: model unavailable, using the script', err);
            } finally {
                clearTimeout(timer);
                this.abort = new AbortController();
            }
            if (!turn) this.offline = true;
        }
        // The model sometimes never gets round to it; past the limit the creature's own wish stands.
        if (turn && !turn.quest && replies >= MAX_REPLIES) {
            const w = this.mind.wish;
            turn = { line: turn.line + ' ' + w.why, options: [ACCEPT, DECLINE], quest: { ...w, brief: w.why } };
        }
        if (!turn) turn = scriptedTurn(this.mind, this.history, this.memory);
        this.history.push({ turn });
        return turn;
    }
}
