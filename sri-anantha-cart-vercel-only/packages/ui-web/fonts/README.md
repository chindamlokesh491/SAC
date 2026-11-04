# Fonts

Self-hosted so builds never download from Google and pages make no third-party font requests.

| File | Font | Characters |
| --- | --- | --- |
| `inter-latin.woff2` | Inter (variable, weight 100–900) | Basic Latin and punctuation |
| `inter-rupee.woff2` | Inter | ₹ only (U+20B9), subset with fontTools |
| `source-serif-4-latin.woff2` | Source Serif 4 (variable, weight 200–900) | Basic Latin and punctuation |
| `source-serif-4-rupee.woff2` | Source Serif 4 | ₹ only |

Before this, the ₹ sign made every price page download the fonts' whole "latin-ext" files (85 KB + 42 KB).

Both fonts are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org), which allows
bundling and redistribution: Inter © The Inter Project Authors; Source Serif 4 © Adobe.
