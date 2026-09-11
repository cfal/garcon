# Image-model notes

Research date: 2026-09-10.

## Selected models

- **OpenAI — `gpt-image-2.5-sunburst`.** Official OpenAI documentation describes Sunburst as the choice when editing precision matters most, with `gpt-image-2.5-flare` positioned for faster everyday generation. Source: [OpenAI Image generation guide](https://developers.openai.com/api/docs/guides/image-generation).
- **Google — `gemini-3-pro-image` (Nano Banana Pro).** Google describes it as the premium option for complex visual work. Source: [Gemini image generation guide](https://ai.google.dev/gemini-api/docs/image-generation).

## Availability outcome

- The Google credential configured in `~/.opencode/opencode.json` exposed `gemini-3-pro-image` and generated both source boards.
- The configured OpenAI endpoint rejected `gpt-image-2.5-sunburst`. The same configured credential was not valid against the official OpenAI Image API. No alternate credential source or older model was used.
- No credential values are stored in this directory.

## Design boundary

Generative image models are useful for divergent logo exploration but unreliable as production logo sources. Their raster boards may contain inconsistent geometry, backgrounds, or near-duplicates. The 28 candidates in `candidates/` therefore use manually authored SVG geometry, a fixed palette, stable safe-area rules, and deterministic filenames.
