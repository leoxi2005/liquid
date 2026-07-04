#version 300 es
precision highp float;
precision highp sampler2D;

// Inject dye wherever the camera silhouette mask is lit — the body's shape
// literally prints into the fluid every frame.

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTarget;
uniform sampler2D uMask;
uniform vec3 color;
uniform float mirror; // 1 = flip x (facing-the-screen feel)
uniform float clampValue;

void main () {
    vec2 muv = vec2(mirror > 0.5 ? 1.0 - vUv.x : vUv.x, 1.0 - vUv.y);
    float m = texture(uMask, muv).r;
    vec3 base = texture(uTarget, vUv).xyz;
    // soft ceiling: emission fades as local dye approaches saturation, so a
    // standing body reaches a visible equilibrium instead of burning to black
    float headroom = max(0.0, 1.0 - dot(base, vec3(0.3333)) / 1.0);
    fragColor = vec4(clamp(base + m * color * headroom, vec3(-clampValue), vec3(clampValue)), 1.0);
}
