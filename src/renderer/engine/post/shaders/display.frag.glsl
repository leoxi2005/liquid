#version 300 es
precision highp float;
precision highp sampler2D;

// Final compose. Style variants via Material keywords:
//   (base)          additive ink/light on dark
//   PAPER           subtractive watercolor on light paper
//   PAPER + OIL     dense glossy pigment, specular highlights
//   PAPER + CONTOUR watercolor + topographic isolines
//   NEON            light lives on density edges — filament look
//   SMOKE           desaturated volumetric smoke
//   FLOW            hue rotates with local flow direction (iridescent)
// plus SHADING / BLOOM / SUNRAYS composable as before.

in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform vec2 texelSize;
uniform float aspect;
uniform vec3 bgColor;
uniform float bgGradient;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform float lift;
uniform float gamma;
uniform float gain;
uniform float vignette;
uniform float grain;
uniform float paperTexture;
uniform float uTime;
// beat envelope 0–1 — display-side throb, never disturbs the fluid itself
uniform float beatPulse;

#ifdef BLOOM
uniform sampler2D uBloom;
uniform float bloomIntensity;
#endif

#ifdef SUNRAYS
uniform sampler2D uSunrays;
uniform vec3 sunraysColor;
#endif

#ifdef FLOW
uniform sampler2D uVelocity;
#endif

#if defined(SHADING) || defined(NEON) || defined(OIL) || defined(SMOKE) || defined(CONTOUR) || defined(PAPER)
#define NEED_GRADIENT
#endif

vec3 aces (vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// interleaved gradient noise — blue-noise-like distribution, no texture needed
float ign (vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hash (vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// smooth value noise — paper tooth & pigment granulation
float vnoise (vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Rodrigues rotation around the grey axis — cheap hue rotate
vec3 hueRotate (vec3 color, float angle) {
    const vec3 k = vec3(0.57735);
    float ca = cos(angle);
    float sa = sin(angle);
    return color * ca + cross(k, color) * sa + k * dot(k, color) * (1.0 - ca);
}

void main () {
    vec3 c = texture(uTexture, vUv).rgb;

    vec2 rv = (vUv - 0.5) * vec2(aspect, 1.0);
    float radial = length(rv);

#ifdef NEED_GRADIENT
    // density gradient → edge magnitude + fake normal light
    vec3 lc = texture(uTexture, vL).rgb;
    vec3 rc = texture(uTexture, vR).rgb;
    vec3 tc = texture(uTexture, vT).rgb;
    vec3 bc = texture(uTexture, vB).rgb;
    float dx = length(rc) - length(lc);
    float dy = length(tc) - length(bc);
    float edge = length(vec2(dx, dy));
    vec3 n = normalize(vec3(dx, dy, length(texelSize)));
    vec3 l = normalize(vec3(0.35, 0.5, 0.8));
    float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.1);
    float spec = pow(max(dot(n, normalize(l + vec3(0.0, 0.0, 1.0))), 0.0), 24.0);
#else
    float edge = 0.0;
    float diffuse = 1.0;
    float spec = 0.0;
#endif

#ifdef PAPER
    // --- subtractive: pigment on paper -------------------------------------
#ifdef NEED_GRADIENT
    // wet-edge pigment separation: channels drift apart along the gradient,
    // leaving the faint rainbow fringe real washes get as they dry
    float sep = smoothstep(0.02, 0.2, edge) * (0.6 + paperTexture * 1.2);
    vec2 gdir = edge > 1e-5 ? normalize(vec2(dx, dy)) : vec2(0.0);
    c.r = texture(uTexture, vUv + gdir * texelSize * sep).r;
    c.b = texture(uTexture, vUv - gdir * texelSize * sep).b;
#endif
    // granulation: pigment settles into the paper tooth unevenly.
    // pixel-space noise — uv-space scaled with aspect and turned into
    // per-pixel grit on ultra-wide outputs
    float gran = vnoise(gl_FragCoord.xy * 0.22) * 0.6 + vnoise(gl_FragCoord.xy * 0.48) * 0.4;
    float dens = dot(c, vec3(0.3333));
    // the kick momentarily deepens every wash — the whole painting breathes
    float absorb = 3.2 + beatPulse * 1.6;
#ifdef OIL
    absorb = 4.4 + beatPulse * 1.8;
#endif
    vec3 ink = exp(-c * absorb);
    float granMask = smoothstep(0.02, 0.3, dens) * (1.0 - smoothstep(0.5, 1.1, dens) * 0.8);
    ink = pow(ink, vec3(1.0 + (gran - 0.5) * 0.6 * paperTexture * granMask));
#ifdef NEED_GRADIENT
    // wet-edge pooling: pigment settles where the density gradient is steep
    float pool = smoothstep(0.0, 0.22, edge);
    ink *= 1.0 - pool * 0.38;
#endif
#ifdef SHADING
    ink = mix(ink, ink * diffuse, 0.8);
#endif
#ifdef CONTOUR
    // topographic isolines carved into the wash
    float band = fract(dens * 8.0);
    float distToLine = min(band, 1.0 - band);
    float line = 1.0 - smoothstep(0.02, 0.08, distToLine);
    ink *= 1.0 - line * 0.5 * smoothstep(0.03, 0.12, dens);
#endif
    float bgFall = mix(1.0, smoothstep(1.25, 0.2, radial) * 0.22 + 0.8, bgGradient);
    // two-scale paper tooth: soft fiber clumps + fine grain, user-scaled
    float paperGrain = 1.0
        + ((vnoise(gl_FragCoord.xy * 0.11) - 0.5) * 0.055
        + (ign(gl_FragCoord.xy * 0.71) - 0.5) * 0.04) * paperTexture;
    vec3 scene = bgColor * ink * bgFall * paperGrain;
#ifdef OIL
    // glossy highlights riding the pigment ridges
    scene += spec * 0.45 * smoothstep(0.05, 0.7, length(c));
#endif

    scene *= 1.0 - vignette * 0.5 * smoothstep(0.45, 1.05, radial);
    scene *= exposure;
    scene = clamp(scene, 0.0, 1.0);
#else
    // --- additive: light on dark -------------------------------------------
#ifdef FLOW
    vec2 vel = texture(uVelocity, vUv).xy;
    float flowAng = atan(vel.y, vel.x);
    float flowSpd = length(vel);
    c = hueRotate(c, flowAng);
    c *= 1.0 + min(flowSpd * 0.003, 0.5);
#endif
#ifdef SMOKE
    float smokeLum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(smokeLum), 0.82);
    c *= diffuse * diffuse * 1.25; // deep self-shadowing sells the volume
#endif
#ifdef SHADING
    c *= diffuse;
    c += spec * 0.15 * smoothstep(0.05, 0.6, length(c));
    // rim light: edges catch a cool self-tinted highlight — extra depth for free
    float rim = smoothstep(0.08, 0.45, edge);
    c += rim * normalize(c + 1e-4) * 0.28 * smoothstep(0.02, 0.35, length(c));
#endif
#ifdef NEON
    // hollow out the body, light only the rims — bloom does the rest
    float filament = smoothstep(0.05, 0.35, edge);
    c = c * 0.18 + c * filament * 3.2;
#endif

#ifdef SUNRAYS
    float sr = texture(uSunrays, vUv).r;
    c += sr * sunraysColor;
#endif

#ifdef BLOOM
    c += texture(uBloom, vUv).rgb * bloomIntensity;
#endif

    // background: gentle radial falloff keeps projector blacks from feeling dead
    float bgFall = mix(1.0, smoothstep(1.1, 0.1, radial) * 0.9 + 0.35, bgGradient);
    vec3 scene = bgColor * bgFall + c;

    scene *= 1.0 - vignette * smoothstep(0.45, 1.05, radial);
    // kick → brief glow lift
    scene *= exposure * (1.0 + beatPulse * 0.18);
    scene = aces(scene);
#endif

    scene = gain * pow(max(scene, vec3(0.0)), vec3(1.0 / max(gamma, 0.01))) + lift;
    scene = (scene - 0.5) * contrast + 0.5;
    float lum = dot(scene, vec3(0.299, 0.587, 0.114));
    scene = mix(vec3(lum), scene, saturation);

    scene += (hash(vUv * 731.7 + fract(uTime) * 913.1) - 0.5) * grain;
    // 8-bit dither — mandatory, dark gradients band badly on projectors otherwise
    scene += (ign(gl_FragCoord.xy + fract(uTime * 0.13) * 191.0) - 0.5) * (2.0 / 255.0);

    fragColor = vec4(max(scene, vec3(0.0)), 1.0);
}
