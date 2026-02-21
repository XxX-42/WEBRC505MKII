---
description: RC-505mkII Parameter Extraction and Mapping Plan
---

# Plan: RC-505mkII Parameter Extraction and JS Mapping

## Objective
Extract detailed FX parameter names and structures from the `RC-505mkII 用户手册.pdf` (User Manual) and update `SemanticMapper.js` to replace generic parameter names (Param A, B, etc.) with human-readable names.

## Status Analysis
- Current `SemanticMapper.js` has partial mappings ported from incomplete Java code.
- `manual_dump.txt` contains the text content of the User Manual, but it seems to describe *operations* rather than a full parameter list for every effect.
- The User Manual (page 25, "Main Specifications") lists:
    - INPUT FX: 49 types
    - TRACK FX: 53 types
    - MASTER FX: 2 types
- The User Manual repeatedly refers to a separate **"Parameter Guide" (参数指南)** for detailed parameter information (e.g., page 11, 13, 14, 15, 16, 17, 20).
    - Page 1: "参数指南（从网上下载）... 该指南介绍了 RC-505mkll 的所有参数。" (Parameter Guide (Download from Web)... This guide introduces all parameters of RC-505mkll.)
- **CRITICAL FINDING**: The `manual_dump.txt` confirms that the *User Manual* does NOT contain the detailed parameter lists for specific effects (like LPF rate, depth, resonance, etc.). It only describes *how* to edit them. The detailed list is in the *Parameter Guide*, which I do **NOT** have access to (it was mentioned as a missing file `RC_505mkII_Parameter_Guide_eng03_W.pdf` in Step 826).

## Strategy Adjustment
Since I cannot read the *Parameter Guide*, I must rely on:
1.  **Inference from `XmlParserFX.java` (limited)**: Extract whatever is available, even if incomplete.
2.  **Common Boss/Roland FX Knowledge**: Use standard parameter structures for common effects (Filter, Phaser, Flanger, Delay, Reverb, Slice, etc.).
3.  **User Interaction**: inform the user that the *User Manual* lacks the specific FX parameter lists and that the *Parameter Guide* is missing. I will do my best with available info and patterns.

## Revised Steps

1.  **Analyze `manual_dump.txt` for any scattered FX info**: Check pages 16-17 (Editing Input/Track FX) again for any examples. (Done: It mostly says "Refer to Parameter Guide").
2.  **Refine `SemanticMapper.js` with "Best Guess" Patterns**:
    - **Filter/Modulation (LPF, BPF, PHASER, FLANGER, SYNTH)**: Rate, Depth, Resonance, Cutoff are standard.
    - **Delays**: Time, Feedback, E.Level, D.Level.
    - **Reverbs**: Time, Tone, E.Level.
    - **Vocal FX (Vocoder, Robot)**: Formant, Balance, Gender.
    - **Dynamics (Compressor)**: Threshold, Ratio, Attack, Release, Level.
3.  **Implement a "Generic Map" with intelligent naming**:
    - If `FX_DEFS` is missing an entry, try to map based on value type (e.g., if value is "ON/OFF", name might be "SW"; if 0-100, "Level" or "Depth"). (This is hard without metadata).
4.  **Action**: I will update `SemanticMapper.js` with an expanded `FX_DEFS` list covering the 49/53 types as best as I can guess, or strictly follow the Java code's `PARAM_MAPPERS` keys to at least format the *values* correctly.

## Specific Task Loop (for this session)
1.  **Notify User**: Explain that the User Manual does *not* contain the parameter list (it points to a separate Parameter Guide).
2.  **Best Effort Mapping**: Update `SemanticMapper.js` with a comprehensive list of likely FX types and their standard parameters. I will use the `PARAM_MAPPERS` keys found in `XmlParserFX.java` (like `OSC`, `CARRIER`, `TONE`, `FORMANT`) to populate the FX Definitions for likely candidates (e.g., `ROBOT` -> `FORMANT`, `OSC`).

## FX Type List Construction (Mental Draft)
Based on `XmlParserFX.java` mappers:
- `OSC`, `CARRIER` -> Slicer? Ring Mod?
- `TONE`, `FORMANT` -> Robot? Vocal Synth?
- `MODSENS` -> Synth?
- `OCTAVE` -> Octave/Pitch Shift.
- `PATTERN` -> Slicer / Beat Scatter.
- `PHRASE` -> ?
- `DYNAMICS` -> Compressor / Limiter.
- `AMP TYPE` -> Guitar Amp Simulator?

I will try to match these to standard RC-505 effect names.
