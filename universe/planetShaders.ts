// Shaders for standing on a planet: a physically based sky (the GLSL twin of
// atmosphere.ts), terrain lit by sunlight that has crossed the atmosphere and
// seen through it (aerial perspective), and water with Fresnel reflection.
// Scene units are metres; the atmosphere math runs in planet radii.

import { TERRAIN_GLSL } from './terrain';

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform float uHasAtmo;
uniform float uTop;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform float uHR;
uniform float uHM;
uniform float uG;
uniform vec3 uForwardTint;
uniform float uMulti;
uniform vec3 uAbsorbM;
uniform float uSunIntensity;
uniform vec3 uSunDir;
uniform float uPlanetR;   // metres
uniform float uCamAlt;    // metres above the datum

vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
}

// In-scattered light along ro + rd·t for t in [0, maxT] (planet radii), and the transmittance.
vec3 scatter(vec3 ro, vec3 rd, float maxT, out vec3 transmittance) {
    transmittance = vec3(1.0);
    if (uHasAtmo < 0.5) return vec3(0.0);
    vec2 a = raySphere(ro, rd, uTop);
    if (a.x > a.y || a.y < 0.0) return vec3(0.0);
    vec2 gr = raySphere(ro, rd, 1.0);
    float tEnd = min(a.y, maxT);
    if (gr.x > 0.0) tEnd = min(tEnd, gr.x);
    float tStart = max(a.x, 0.0);
    if (tEnd <= tStart) return vec3(0.0);
    float span = tEnd - tStart;
    float mu = dot(rd, uSunDir);
    float phaseR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
    float g = uG;
    float phaseM = 3.0 / (8.0 * 3.14159265) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5))
        + uMulti / (4.0 * 3.14159265);
    vec3 tint = mix(vec3(1.0), uForwardTint, pow(max(mu, 0.0), 16.0));
    vec3 sumR = vec3(0.0), sumM = vec3(0.0);
    float odR = 0.0, odM = 0.0;
    // Samples crowd towards the observer (t ∝ (i/N)²): in thick air all the light comes from close by.
    for (int i = 0; i < STEPS; i++) {
        float u0 = float(i) / float(STEPS), u1 = float(i + 1) / float(STEPS);
        float seg = span * (u1 * u1 - u0 * u0);
        float um = (u0 + u1) * 0.5;
        vec3 p = ro + rd * (tStart + span * um * um);
        float h = length(p) - 1.0;
        float dR = exp(-h / uHR) * seg, dM = exp(-h / uHM) * seg;
        odR += dR; odM += dM;
        vec2 l = raySphere(p, uSunDir, uTop);
        float segL = l.y / float(LIGHT_STEPS);
        float lR = 0.0, lM = 0.0;
        bool blocked = false;
        for (int j = 0; j < LIGHT_STEPS; j++) {
            vec3 pl = p + uSunDir * (segL * (float(j) + 0.5));
            float hl = length(pl) - 1.0;
            if (hl < 0.0) { blocked = true; break; }
            lR += exp(-hl / uHR) * segL;
            lM += exp(-hl / uHM) * segL;
        }
        if (blocked) continue;
        vec3 att = exp(-(uBetaR * (odR + lR) + (uBetaM * 1.1 + uAbsorbM) * (odM + lM)));
        sumR += att * dR;
        sumM += att * dM;
    }
    transmittance = exp(-(uBetaR * odR + (uBetaM * 1.1 + uAbsorbM) * odM));
    return uSunIntensity * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM * tint);
}

// Observer position in planet radii: the local flat ground is tangent to the sphere at the origin.
vec3 observer() { return vec3(0.0, 1.0 + uCamAlt / uPlanetR, 0.0); }
`;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Clouds: a layer of cumulus (or thin ice haze) between two altitudes, marched
// through with light sampled towards the Sun, so tops shine, bases go grey and
// edges glow when the Sun is behind. The same density field casts shadows that
// drift across the ground. Needs the terrain noise (TERRAIN_GLSL) and uSunDir.
// ---------------------------------------------------------------------------

export const CLOUDS_GLSL = /* glsl */ `
uniform float uCloudCover;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform vec3 uCloudAlbedo;
uniform vec2 uWind;

float cloudMap(vec3 p, int octaves) {
    float h = (p.y - uCloudBase) / (uCloudTop - uCloudBase);
    if (h <= 0.0 || h >= 1.0) return 0.0;
    vec2 q = (p.xz + uWind) * 0.00011;
    float n = tfbm(q, octaves) * 0.5 + 0.5;
    // Flat bases, domed tops: higher up, only the cores of the cells are still cloud.
    float profile = smoothstep(0.0, 0.1, h) * (1.0 - 0.85 * smoothstep(0.3, 1.0, h));
    float threshold = 0.5 - (uCloudCover - 0.5) * 0.42;
    float d = (n - threshold) * profile - (1.0 - profile) * 0.05;
    // Billows: eat into the edges with finer noise.
    d -= (tnoise(q * 5.3 + vec2(h * 1.7, -h)) * 0.5 + 0.5) * 0.045;
    return clamp(d * 7.0, 0.0, 1.0) * uCloudDensity;
}

float hgPhase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// Light scattered by the clouds along ro + rd·t (metres; ro.y is the altitude) for t < tMax.
// T is the transmittance through them. Far layers get a few even samples (smooth, no grain);
// near ones, or from inside the layer, more samples crowded towards the eye.
vec3 marchClouds(vec3 ro, vec3 rd, float tMax, int steps, int octaves, vec3 sunCol, vec3 skyCol, out float T) {
    T = 1.0;
    if (uCloudCover <= 0.0) return vec3(0.0);
    float t0, t1;
    if (abs(rd.y) < 1e-4) {
        if (ro.y < uCloudBase || ro.y > uCloudTop) return vec3(0.0);
        t0 = 0.0; t1 = 1e9;
    } else {
        float ta = (uCloudBase - ro.y) / rd.y, tb = (uCloudTop - ro.y) / rd.y;
        t0 = max(min(ta, tb), 0.0);
        t1 = max(ta, tb);
    }
    // Near the horizon the slab stretches for hundreds of km; the far part is lost in haze anyway.
    t1 = min(min(t1, tMax), t0 + 18000.0);
    if (t1 <= t0 || t0 > 90000.0) return vec3(0.0);
    float span = t1 - t0;
    bool far = t0 > 3000.0;
    int n = far ? 5 : steps;
    // Interleaved gradient noise: an even, fine-grained jitter that hides banding near by.
    float jitter = far ? 0.5 : fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float mu = dot(rd, uSunDir);
    // A bright forward lobe (the silver lining) and a softer back-scatter.
    float phase = mix(hgPhase(mu, 0.65), hgPhase(mu, -0.25), 0.35) * 4.0 * 3.14159265;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 32; i++) {
        if (i >= n) break;
        float u0 = float(i) / float(n), u1 = float(i + 1) / float(n);
        float um = (float(i) + jitter) / float(n);
        float t = far ? t0 + span * um : t0 + span * um * um;
        float dt = far ? span / float(n) : span * (u1 * u1 - u0 * u0);
        vec3 p = ro + rd * t;
        float d = cloudMap(p, octaves);
        if (d > 0.002) {
            float sigma = d * 0.035;
            float od = 0.0;
            for (int j = 0; j < 3; j++) od += cloudMap(p + uSunDir * (60.0 + 180.0 * float(j)), 3) * 0.035 * 180.0;
            float h = (p.y - uCloudBase) / (uCloudTop - uCloudBase);
            // Beer's law towards the Sun, with the "powder" darkening of cloud edges seen sunward.
            float beer = exp(-od) + 0.25 * exp(-od * 0.25);
            float powder = 1.0 - exp(-sigma * 120.0);
            vec3 S = uCloudAlbedo * (sunCol * beer * phase * mix(1.0, powder, 0.5) * 0.9 + skyCol * (0.45 + 0.55 * h));
            float ext = exp(-sigma * dt);
            acc += T * S * (1.0 - ext);
            T *= ext;
            if (T < 0.02) break;
        }
    }
    // Distant clouds sink into the haze.
    float fade = exp(-t0 / 60000.0);
    T = mix(1.0, T, fade);
    return acc * fade;
}

// How much of the Sun a point on the ground sees past the clouds.
float cloudShadow(vec3 p) {
    if (uCloudCover <= 0.0 || uSunDir.y <= 0.03) return 1.0;
    float mid = mix(uCloudBase, uCloudTop, 0.3);
    vec3 q = p + uSunDir * ((mid - p.y) / uSunDir.y);
    float d = cloudMap(q, 3) + cloudMap(q + uSunDir * 900.0, 3);
    return mix(1.0, 0.12, clamp(d * 1.3, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------

export const SKY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
    vDir = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
}
`;

export const SKY_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#define STEPS 16
#define LIGHT_STEPS 8
${ATMOSPHERE_GLSL}
${TERRAIN_GLSL}
${CLOUDS_GLSL}
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uTime;
varying vec3 vDir;
vec3 h33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}
void main() {
    #include <logdepthbuf_fragment>
    vec3 rd = normalize(vDir);
    vec3 trans;
    vec3 col = scatter(observer(), rd, 1e9, trans);
    // The Sun's disk (0.27° radius at 1 AU), dimmed by the air in front of it.
    float cosSun = dot(rd, uSunDir);
    float disk = smoothstep(0.99997, 0.999985, cosSun);
    col += uSunColor * disk * 40.0 * trans;
    // Stars come out where the sky is dark.
    float sky = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 q = rd * 260.0;
    vec3 cell = floor(q);
    vec3 h = h33(cell);
    if (h.x > 0.975 && rd.y > -0.05) {
        float d = length(q - cell - 0.5 - 0.35 * (h33(cell + 3.0) - 0.5));
        col += vec3(0.8 + 0.2 * h.y, 0.85, 0.8 + 0.3 * h.z) * exp(-d * d * 40.0) * (0.3 + 1.5 * h.z * h.z) * trans * clamp(1.0 - sky * 8.0, 0.0, 1.0);
    }
    // Meteors burning up in the upper air, visible once the sky is dark.
    if (uHasAtmo > 0.5 && rd.y > 0.0) {
        float dark = clamp(1.0 - sky * 10.0, 0.0, 1.0);
        for (int k = 0; k < 3; k++) {
            float cyc = uTime / 3.1 + float(k) * 0.37;
            float slot = floor(cyc), ph = fract(cyc);
            vec3 hh = h33(vec3(slot, float(k), 7.0));
            if (hh.z > 0.6) continue;
            vec3 a = normalize(vec3(hh.x * 2.0 - 1.0, 0.35 + 0.6 * hh.y, hh.z * 2.0 - 1.0));
            vec3 b = normalize(a + vec3(0.3 * (hh.y - 0.5), -0.2, 0.3 * (hh.x - 0.5)));
            float p1 = min(ph * 3.0, 1.0);
            vec3 head = normalize(mix(a, b, p1)), tail = normalize(mix(a, b, max(p1 - 0.35, 0.0)));
            vec3 ab = head - tail;
            float t = clamp(dot(rd - tail, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
            float d = length(rd - (tail + ab * t));
            col += vec3(1.0, 0.9, 0.75) * smoothstep(0.003, 0.0, d) * t * (1.0 - p1) * 6.0 * dark;
        }
    }
    // Clouds in front of all of it.
    float T;
    vec3 cl = marchClouds(cameraPosition, rd, 1e9, 22, 5, uSunColor, uAmbient, T);
    col = col * T + cl;
    gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------

export const TERRAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${TERRAIN_GLSL}
uniform vec2 uOffset;
uniform float uPlanetRV;
varying vec3 vWorld;
varying float vDrop;
void main() {
    vec2 xz = position.xz + uOffset;
    float h = terrainHeight(xz, 8);
    // The ground curves away with the planet: drop = d² / 2R.
    vec2 rel = xz - cameraPosition.xz;
    float drop = dot(rel, rel) / (2.0 * uPlanetRV);
    vWorld = vec3(xz.x, h, xz.y);
    vDrop = drop;
    gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, h - drop, xz.y, 1.0);
    #include <logdepthbuf_vertex>
}
`;

/** Materials of every world: Earth's own path, and one driven by uniforms (worlds.ts) for the rest. */
const MATERIAL_GLSL = /* glsl */ `
uniform int uPalette;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uRock;
uniform vec3 uColC;
uniform vec3 uColD;
uniform int uFeature;
uniform float uRoughness;

// The nearest crater of the field tcraters() draws: distance in its radii, how fresh it is,
// and the direction from its centre (for ray streaks).
vec4 craterNear(vec2 q) {
    vec2 i0 = floor(q);
    vec4 best = vec4(1e9, 0.0, 0.0, 0.0);
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
        vec2 c = i0 + vec2(float(i), float(j));
        if (thash(c + vec2(5.0, 11.0)) < 0.35) continue;
        float r = 0.12 + 0.3 * thash(c + vec2(17.0, 3.0));
        vec2 pc = c + vec2(thash(c + vec2(0.0, 7.0)), thash(c + vec2(7.0, 0.0)));
        vec2 d = q - pc;
        float dn = length(d) / r;
        if (dn < best.x) best = vec4(dn, thash(c + vec2(3.0, 23.0)), atan(d.y, d.x), r);
    }
    return best;
}

struct Mat { vec3 albedo; float rough; vec3 glow; };

Mat material(float h, vec3 N, vec2 xz, float cavity, float dist) {
    float rel = h / max(uRelief, 1.0);
    float level = smoothstep(0.55, 0.85, N.y);             // 1 on level ground, 0 on cliffs
    // Colour patches from warped noise: plain value noise lines up with its grid and looks blocky.
    vec2 wq = xz + vec2(tfbm(xz * 0.0011 + 1.7, 2), tfbm(xz * 0.0011 + 9.2, 2)) * 420.0;
    float n1 = tfbm(wq * 0.0021, 5);                        // large patches
    float n2 = tfbm(wq * 0.021 + 3.3, 2);                   // meadows, scree
    float n3 = tnoise(wq * 0.21) * smoothstep(1200.0, 150.0, dist); // close-up grain
    float n4 = tnoise(xz * 1.9) * smoothstep(120.0, 10.0, dist);    // underfoot
    // The forest mask must match where the trees stand (scatter.ts): unwarped.
    float nf = tfbm(xz * 0.0021, 4);
    // Sedimentary strata in exposed rock, warped so the bands follow the terrain.
    float strata = 0.5 + 0.5 * sin(h * 0.045 + n1 * 6.0 + n2 * 1.5);
    Mat m;
    m.rough = 0.9;
    m.glow = vec3(0.0);
    if (uPalette == 0) { // Earth: soil and rock under grass, forest, alpine meadow and snow
        vec3 rock = mix(vec3(0.2, 0.19, 0.17), vec3(0.4, 0.37, 0.32), strata) * (0.85 + 0.15 * n2);
        vec3 meadow = mix(vec3(0.075, 0.15, 0.035), vec3(0.2, 0.24, 0.07), smoothstep(-0.4, 0.5, n1 + n2 * 0.3));
        meadow = mix(meadow, vec3(0.22, 0.2, 0.09), smoothstep(0.35, 0.8, n2 * 0.6 + n3 * 0.5) * 0.5); // dry grass
        // Forest canopy: dark, clumpy, lit crowns and shadowed gaps.
        float crowns = tnoise(xz * 0.09) * 0.5 + 0.5;
        vec3 forest = mix(vec3(0.012, 0.03, 0.01), vec3(0.04, 0.085, 0.025), crowns);
        float forestMask = smoothstep(0.02, 0.18, nf) * smoothstep(0.6, 0.3, rel) * smoothstep(0.7, 0.9, N.y);
        vec3 alpine = vec3(0.28, 0.26, 0.18);
        vec3 sand = vec3(0.6, 0.53, 0.38);
        vec3 veg = mix(meadow, forest, forestMask);
        veg = mix(veg, alpine, smoothstep(0.55, 0.85, rel + n2 * 0.08));
        vec3 c = mix(rock, veg, level);
        // Bare soil and scree between the grass close up.
        c = mix(c, vec3(0.16, 0.12, 0.08), smoothstep(0.55, 0.9, n4 * 0.5 + n3 * 0.5) * 0.35 * level);
        float beach = smoothstep(uSea + 25.0, uSea + 6.0, h) * smoothstep(0.4, 0.8, N.y);
        c = mix(c, sand, beach);
        c *= mix(1.0, 0.55, smoothstep(uSea + 3.0, uSea + 0.5, h));   // wet sand at the waterline
        float snow = smoothstep(0.92, 1.05, rel + n1 * 0.12 + n3 * 0.02) * smoothstep(0.45, 0.75, N.y + n2 * 0.1);
        c = mix(c, vec3(0.86, 0.89, 0.93), snow);
        m.rough = mix(0.95, 0.35, snow);
        m.albedo = c * (0.9 + 0.2 * n3) * (0.93 + 0.14 * n4);
    } else {
        // The body's own materials: bright and dark ground, rock where it is steep.
        float hi = smoothstep(-0.4, 0.4, n1 * 0.9 + rel * 0.9 + n2 * 0.15);
        vec3 soil = mix(uColB, uColA, hi) * (0.9 + 0.2 * n2);
        vec3 rock = uRock * mix(0.8, 1.2, strata);
        vec3 c = mix(rock, soil, level);
        vec2 cq = (xz * 0.00008 + vec2(uSeed, uSeed * 0.7)) * 1.6;
        vec4 cr = uCraters > 0.5 ? craterNear(cq) : vec4(1e9);
        m.rough = uRoughness;
        if (uFeature == 12) {
            // The Moon: dark basalt floods the broad lowlands (maria), highlands stay bright.
            float mare = smoothstep(0.08, -0.12, tfbm(wq * 0.00025 + 3.7, 4) + rel * 0.4);
            c = mix(c, uColB * (0.9 + 0.2 * n2), mare * level);
        } else if (uFeature == 1) {
            // Mercury: bluish dark plains between brighter, browner intercrater terrain.
            c = mix(c, uColB, smoothstep(0.1, -0.2, n1) * 0.7);
        } else if (uFeature == 2) {
            // Io: sulfur fields, white SO₂ frost, red rings round the vents, black lava lakes that glow.
            vec3 sulfur = mix(uColB, uColA, smoothstep(-0.35, 0.35, n1 + 0.3 * n2));
            sulfur = mix(sulfur, uColC, smoothstep(0.2, 0.6, tfbm(wq * 0.0009 + 7.1, 4)) * level * 0.8);
            c = mix(rock, sulfur, level);
            vec2 vq = xz * 0.00018;
            vec2 vc = floor(vq);
            vec2 vp = vc + vec2(thash(vc + 1.3), thash(vc + 7.9));
            float vd = length(vq - vp);
            float live = step(0.55, thash(vc + 4.4));
            c = mix(c, vec3(0.45, 0.08, 0.02), smoothstep(0.35, 0.18, vd) * smoothstep(0.08, 0.14, vd) * live * 0.8);
            float lake = smoothstep(0.1, 0.06, vd) * live;
            c = mix(c, uColD, lake);
            float crust = tnoise(xz * 0.05 + uTime * 0.02) * 0.5 + 0.5;
            m.glow = vec3(1.0, 0.25, 0.03) * lake * smoothstep(0.55, 0.9, crust) * 2.5
                   + vec3(1.0, 0.35, 0.05) * smoothstep(0.1, 0.095, vd) * smoothstep(0.08, 0.1, vd) * live * 3.0;
        } else if (uFeature == 3) {
            // Europa: crossing lineae (double ridges stained with salts) and patches of chaos.
            float l1 = abs(tfbm(xz * 0.00016 + 2.0, 3));
            float l2 = abs(tfbm(xz.yx * 0.00031 - 5.0, 3));
            float lines = max(smoothstep(0.03, 0.0, l1), smoothstep(0.022, 0.0, l2) * 0.8);
            float edge = max(smoothstep(0.05, 0.03, l1) - smoothstep(0.03, 0.0, l1), 0.0);
            c = mix(c, uColC, lines * 0.85);
            c += edge * 0.08;
            c = mix(c, uColD * (0.85 + 0.3 * n2), smoothstep(0.35, 0.55, tfbm(wq * 0.0004 + 11.0, 4)) * 0.8);
        } else if (uFeature == 4) {
            // Ganymede, Miranda: dark ancient terrain and bright lanes scored by parallel grooves.
            float lane = smoothstep(-0.05, 0.1, tfbm(wq * 0.00022 + 1.3, 4));
            float grooves = 0.5 + 0.5 * sin(dot(xz, vec2(0.61, 0.79)) * 0.02 + n1 * 4.0);
            c = mix(uColB * (0.9 + 0.2 * n2), uColA * (0.85 + 0.25 * grooves), lane);
            c = mix(rock, c, level);
        } else if (uFeature == 5) {
            // Callisto: dark lag deposits, bright frost on crests and crater rims.
            float crest = smoothstep(0.65, 0.95, cavity) * smoothstep(0.1, 0.4, rel + n2 * 0.1);
            c = mix(c, uColC, crest * 0.7);
        } else if (uFeature == 6) {
            // Enceladus: fresh snow and four long blue fractures.
            float s = xz.x * 0.00006 + tfbm(xz * 0.00005, 2) * 0.8;
            float stripe = smoothstep(0.035, 0.0, abs(fract(s) - 0.5) - 0.01);
            c = mix(c, uColC, stripe);
            m.rough = mix(uRoughness, 0.2, stripe);
        } else if (uFeature == 7) {
            // Titan: long linear dunes of dark organic sand in the lowlands, pebbles by the shores.
            float dunes = 0.5 + 0.5 * sin(xz.x * 0.004 + tfbm(xz * 0.0005, 3) * 6.0);
            float low = smoothstep(0.1, -0.2, rel);
            c = mix(c, mix(uColA, uColB, smoothstep(0.3, 0.7, dunes)), low * level);
            c = mix(c, uColC, smoothstep(uSea + 20.0, uSea + 2.0, h) * 0.6);
        } else if (uFeature == 8) {
            // Triton: pink frost, dimpled "cantaloupe" terrain, dark streaks blown downwind.
            float dimples = abs(tnoise(xz * 0.004)) + abs(tnoise(xz * 0.009)) * 0.5;
            c = mix(uColB, uColA, smoothstep(0.1, 0.6, dimples + n1 * 0.3));
            float streak = smoothstep(0.55, 0.8, tnoise(vec2(xz.x * 0.0006, xz.y * 0.004)) * 0.5 + 0.5);
            c = mix(c, uColC, streak * 0.6 * level);
        } else if (uFeature == 9) {
            // Iapetus: coal-dark and snow-white, sharply divided.
            float side = smoothstep(-0.04, 0.04, tfbm(xz * 0.00003 + 9.0, 3) + (N.x - N.z) * 0.1);
            c = mix(uColB, uColA, side) * (0.9 + 0.2 * n2);
        } else if (uFeature == 10) {
            // Mars: ochre dust on the flats, dark basaltic sand rippled in the lows, layered rock.
            float low = smoothstep(0.0, -0.25, rel + n1 * 0.15);
            float ripples = 0.5 + 0.5 * sin(dot(xz, vec2(0.8, 0.6)) * 0.35 + n2 * 3.0);
            vec3 sand = mix(uColD, uColB, ripples * smoothstep(300.0, 40.0, dist));
            c = mix(c, sand, low * level);
            c = mix(c, uColC, smoothstep(0.4, 0.7, n1 + n3 * 0.3) * level * 0.4);
        } else if (uFeature == 11) {
            // Venus: platy basalt cracked into slabs, rough tesserae on the heights.
            vec2 cell = floor(xz * 0.35);
            vec2 f = fract(xz * 0.35) - 0.5;
            float plate = thash(cell);
            float crack = smoothstep(0.43, 0.49, max(abs(f.x), abs(f.y)) + tnoise(xz * 1.3) * 0.05) * smoothstep(80.0, 15.0, dist);
            c *= (0.85 + 0.3 * plate * smoothstep(80.0, 15.0, dist)) * (1.0 - crack * 0.6);
            c = mix(c, uColC * (0.8 + 0.4 * abs(n2)), smoothstep(0.35, 0.6, rel + n1 * 0.2));
        } else if (uFeature == 13) {
            // Phobos: chains of pits in parallel grooves.
            float groove = smoothstep(0.75, 0.95, sin(dot(xz, vec2(0.34, 0.94)) * 0.012 + n2 * 0.6) * 0.5 + 0.5);
            c = mix(c, uColC, groove * 0.7);
        } else if (uFeature == 14) {
            // A lava world: black crust, orange light in the cracks and the lows.
            float cracks = smoothstep(0.04, 0.0, abs(tnoise(xz * 0.004 + uTime * 0.01)));
            float low = smoothstep(-0.12, -0.32, rel);
            m.glow = uColD * (cracks * 1.5 + low * (0.7 + 0.3 * sin(uTime + h * 0.01))) * 2.0;
        }
        // Fresh craters: bright ejecta round the rim and rays streaking out (Moon, Mercury, icy moons).
        // (Everything stays within 2.2 radii: craterNear only looks one cell around, so anything
        // reaching further would be cut off along the cell edges in straight lines.)
        if (uCraters > 0.5 && cr.x < 2.2) {
            float fresh = smoothstep(0.75, 0.95, cr.y);
            float halo = smoothstep(1.8, 1.0, cr.x) * smoothstep(0.6, 1.0, cr.x);
            float rays = smoothstep(0.6, 0.95, tnoise(vec2(cr.z * 9.0, cr.y * 50.0)) * 0.5 + 0.5) * smoothstep(2.2, 1.1, cr.x);
            float bright = fresh * max(halo, rays * 0.7);
            c = mix(c, uColC, bright * 0.8);
            // Dark, smoothed floors in the old ones.
            c *= mix(1.0, 0.9, smoothstep(0.9, 0.3, cr.x) * (1.0 - fresh));
        }
        m.albedo = c * (0.9 + 0.2 * n3) * (0.94 + 0.12 * n4);
    }
    // Crevices collect shadow; ridges catch the light.
    m.albedo *= mix(0.55, 1.08, cavity);
    return m;
}
`;

export const TERRAIN_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#define STEPS 6
#define LIGHT_STEPS 3
${TERRAIN_GLSL}
${ATMOSPHERE_GLSL}
${CLOUDS_GLSL}
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uSea;
uniform float uTime;
uniform float uMurk;
// The robot's head lamp, so that at night it lights the ground too.
uniform vec3 uLampPos;
uniform vec3 uLampDir;
uniform float uLampPower;
${MATERIAL_GLSL}
varying vec3 vWorld;
varying float vDrop;

// Soft shadow: march towards the Sun over a coarse copy of the height field and keep
// the narrowest clearance angle (penumbra ∝ clearance / distance).
float terrainShadow(vec3 p, vec3 L) {
    if (L.y <= -0.02) return 0.0;
    float res = 1.0;
    float t = 20.0;
    for (int i = 0; i < 14; i++) {
        vec3 q = p + L * t;
        float h = q.y - terrainHeight(q.xz, 5);
        res = min(res, 10.0 * h / t);
        if (res < 0.001 || q.y > uRelief * 1.6) break;
        t *= 1.6;
    }
    return clamp(res, 0.0, 1.0);
}

void main() {
    #include <logdepthbuf_fragment>
    vec3 P = vec3(vWorld.x, vWorld.y - vDrop, vWorld.z);
    vec3 camToP = P - cameraPosition;
    float dist = length(camToP);
    vec3 V = -camToP / dist;
    // Normals from the full-detail height field; far away fewer octaves, so it does not shimmer.
    int oct = dist < 1500.0 ? 12 : dist < 8000.0 ? 9 : 7;
    float e = clamp(dist * 0.0015, 0.12, 40.0);
    float h0 = terrainHeight(vWorld.xz, oct);
    float hx = terrainHeight(vWorld.xz + vec2(e, 0.0), oct);
    float hz = terrainHeight(vWorld.xz + vec2(0.0, e), oct);
    vec3 N = normalize(vec3(h0 - hx, e, h0 - hz));
    // Pebbles and grit underfoot: fine bumps that only the normal carries.
    float near = smoothstep(60.0, 4.0, dist);
    if (near > 0.0) {
        vec2 g = tnoised(vWorld.xz * 2.3).yz * 0.1 + tnoised(vWorld.xz * 7.1).yz * 0.05;
        N = normalize(N + vec3(-g.x, 0.0, -g.y) * near);
    }
    // Cavity: how far this point sits above or below the smoothed terrain around it.
    float coarse = terrainHeight(vWorld.xz, 5);
    float cavity = clamp(0.6 + (h0 - coarse) / (uRelief * 0.06), 0.0, 1.0);
    Mat m = material(h0, N, vWorld.xz, cavity, dist);

    vec3 L = uSunDir;
    float ndl = max(dot(N, L), 0.0);
    // Start the shadow ray above both the detailed and the coarse surface, so fine bumps do not shadow themselves.
    float shadow = ndl > 0.0 ? terrainShadow(vec3(vWorld.x, max(h0, coarse) + 4.0, vWorld.z), L) : 0.0;
    shadow *= cloudShadow(vWorld);
    // Sunlight, a little specular sheen, the sky's light from above, and light bounced off the ground.
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), mix(8.0, 60.0, 1.0 - m.rough)) * (1.0 - m.rough) * 0.4;
    // Dusty regolith brightens towards the Sun behind the viewer (the opposition surge).
    float surge = 1.0 + 0.35 * smoothstep(0.9, 1.0, dot(V, L)) * step(0.85, m.rough) * (1.0 - uHasAtmo);
    vec3 sun = uSunColor * shadow * (m.albedo * ndl * surge + spec * ndl);
    vec3 sky = uAmbient * m.albedo * (0.35 + 0.65 * (0.5 + 0.5 * N.y)) * mix(0.4, 1.0, cavity);
    vec3 bounce = uSunColor * m.albedo * m.albedo * 0.15 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0) * max(L.y, 0.0);
    vec3 lit = sun + sky + bounce + m.glow;
    if (uLampPower > 0.0) {
        vec3 toLamp = uLampPos - P;
        float dl = length(toLamp);
        vec3 Ld = toLamp / dl;
        float cone = smoothstep(0.82, 0.95, dot(-Ld, uLampDir));
        lit += m.albedo * vec3(1.0, 0.95, 0.85) * uLampPower * cone * max(dot(N, Ld), 0.0) / (1.0 + dl * dl * 0.04);
    }
    // Under the sea: light is absorbed on the way down and back, and waves focus it into caustics.
    float depth = uSea - h0;
    if (depth > 0.0) {
        vec2 cq = vWorld.xz * 0.35 + uTime * vec2(0.3, 0.2);
        float caustic = pow(abs(tnoise(cq) + tnoise(cq * 1.7 - uTime * 0.4)) * 0.5, 2.0) * 3.0;
        lit = lit * exp(-depth * uMurk * vec3(3.0, 1.2, 0.8)) + uSunColor * shadow * caustic * exp(-depth * uMurk * 2.0) * m.albedo * max(L.y, 0.0);
    }
    // Clouds between us and the ground (seen from above them, or low ones in the distance).
    float T;
    vec3 cl = marchClouds(cameraPosition, -V, dist, 10, 4, uSunColor, uAmbient, T);
    // Aerial perspective: the air between us and the ground scatters light in and dims what lies behind.
    vec3 trans;
    vec3 inscatter = scatter(observer(), -V, dist / uPlanetR, trans);
    gl_FragColor = vec4((lit * trans + inscatter) * T + cl, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Water: Gerstner waves that really move the surface near the viewer, a normal
// from the same waves plus ripples, sky and cloud reflection by Fresnel, the
// sea floor seen through shallow water, and surf breaking on the shore.
// ---------------------------------------------------------------------------

const WAVES_GLSL = /* glsl */ `
uniform float uWaveAmp;
// Six Gerstner waves: direction, wavelength (m); speed from deep-water dispersion c = √(gλ/2π).
vec3 gerstner(vec2 p, float t, out vec3 normal) {
    vec3 disp = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float ang = fi * 1.1 + 0.3;
        vec2 d = vec2(cos(ang), sin(ang));
        float lambda = 48.0 / (1.0 + fi * 0.9);
        float k = 6.2831853 / lambda;
        float c = sqrt(9.81 / k);
        float a = uWaveAmp * 0.5 / (1.0 + fi * 0.8);
        float q = 0.6 / (k * a * 6.0 + 1e-4);
        float f = k * (dot(d, p) - c * t);
        disp.x += q * a * d.x * cos(f);
        disp.z += q * a * d.y * cos(f);
        disp.y += a * sin(f);
        n.x -= d.x * k * a * cos(f);
        n.z -= d.y * k * a * cos(f);
        n.y -= q * k * a * sin(f);
    }
    normal = normalize(n);
    return disp;
}
`;

export const WATER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec2 uOffset;
uniform float uSea;
uniform float uPlanetRV;
uniform float uTime;
${WAVES_GLSL}
varying vec3 vWorld;
varying float vDrop;
varying float vCrest;
void main() {
    vec2 xz = position.xz + uOffset;
    vec2 rel = xz - cameraPosition.xz;
    float drop = dot(rel, rel) / (2.0 * uPlanetRV);
    // Real waves close by; further out the normal alone carries them.
    float fade = smoothstep(600.0, 80.0, length(rel));
    vec3 n;
    vec3 w = gerstner(xz, uTime, n) * fade;
    vWorld = vec3(xz.x + w.x, uSea + w.y, xz.y + w.z);
    vCrest = w.y / max(uWaveAmp, 1e-3);
    vDrop = drop;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld.x, vWorld.y - drop, vWorld.z, 1.0);
    #include <logdepthbuf_vertex>
}
`;

export const WATER_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#define STEPS 8
#define LIGHT_STEPS 4
${TERRAIN_GLSL}
${ATMOSPHERE_GLSL}
${CLOUDS_GLSL}
${WAVES_GLSL}
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uMurk;
uniform float uSea;
varying vec3 vWorld;
varying float vDrop;
varying float vCrest;
void main() {
    #include <logdepthbuf_fragment>
    vec3 camToP = vec3(vWorld.x, vWorld.y - vDrop, vWorld.z) - cameraPosition;
    float dist = length(camToP);
    vec3 V = -camToP / dist;
    vec2 p = vWorld.xz;
    float fade = smoothstep(20000.0, 200.0, dist);
    vec3 gn;
    gerstner(p, uTime, gn);
    // Ripples on the swell: finer the closer we look.
    vec2 g = vec2(tnoise(p * 0.11 + uTime * 0.21), tnoise(p.yx * 0.13 - uTime * 0.17)) * 0.08
           + vec2(tnoise(p * 0.9 + uTime * 0.7), tnoise(p.yx * 0.83 - uTime * 0.6)) * 0.04 * smoothstep(300.0, 20.0, dist);
    vec3 N = normalize(mix(vec3(0.0, 1.0, 0.0), gn, fade) + vec3(-g.x, 0.0, -g.y) * fade * smoothstep(0.0, 0.2, uWaveAmp + 0.05));
    if (dot(N, V) < 0.05) N = normalize(N + V * (0.05 - dot(N, V)));
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    float cosT = max(dot(N, V), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
    // The sky it mirrors, with the clouds in it.
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.5));
    float Tc;
    vec3 cl = marchClouds(vec3(p.x, uSea + 2.0, p.y), R, 1e9, 6, 3, uSunColor, uAmbient, Tc);
    sky = sky * Tc + cl;
    float glint = pow(max(dot(R, uSunDir), 0.0), 900.0) * 60.0 * cloudShadow(vWorld);
    // Light coming back out of the water: bluer and darker with depth, greener in the shallows.
    float depth = max(uSea - terrainHeight(vWorld.xz, 8), 0.0);
    vec3 light = uAmbient + uSunColor * max(uSunDir.y, 0.0) * 0.5;
    vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * uMurk)) * light;
    // Crests catch light through their thin tops (subsurface scattering).
    body += uShallow * light * smoothstep(0.2, 1.0, vCrest) * 0.6 * pow(max(dot(-V, uSunDir) * 0.5 + 0.5, 0.0), 2.0);
    vec3 col = mix(body, sky, fresnel) + uSunColor * glint;
    // Surf: bands of foam running up the beach, and whitecaps on high crests.
    float band = sin(depth * 2.2 - uTime * 1.8 + tnoise(p * 0.05) * 3.0) * 0.5 + 0.5;
    float foam = smoothstep(3.0, 0.0, depth) * smoothstep(0.55, 0.95, band) * (0.6 + 0.4 * tnoise(p * 0.4 + uTime * 0.3));
    foam = max(foam, smoothstep(2.5, 0.0, depth) * 0.35);
    foam = max(foam, smoothstep(0.75, 1.0, vCrest) * smoothstep(0.4, 1.0, tnoise(p * 0.3 + uTime * 0.5) * 0.5 + 0.5) * 0.7);
    foam *= fade;
    col = mix(col, (uSunColor * max(uSunDir.y, 0.0) + uAmbient) * 0.85, foam * 0.8);
    // In the shallows the floor shows through.
    float alpha = clamp(max(1.0 - exp(-depth * uMurk * 2.5), fresnel) + foam, 0.0, 1.0);
    alpha = mix(1.0, alpha, smoothstep(3000.0, 400.0, dist));
    vec3 trans;
    vec3 inscatter = scatter(observer(), -V, dist / uPlanetR, trans);
    float T;
    vec3 over = marchClouds(cameraPosition, -V, dist, 8, 4, uSunColor, uAmbient, T);
    gl_FragColor = vec4((col * trans + inscatter) * T + over, alpha);
}
`;

export const ATMO_SHELL_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
#define STEPS 12
#define LIGHT_STEPS 6
${ATMOSPHERE_GLSL}
uniform vec3 uCamLocal;   // camera relative to the planet centre, planet radii (computed in double precision)
uniform float uExposure;
varying vec3 vWorld;
void main() {
    #include <logdepthbuf_fragment>
    vec3 rd = normalize(vWorld - cameraPosition);
    vec3 trans;
    vec3 col = scatter(uCamLocal, rd, 1e9, trans);
    gl_FragColor = vec4(col * uExposure, 1.0);
}
`;
