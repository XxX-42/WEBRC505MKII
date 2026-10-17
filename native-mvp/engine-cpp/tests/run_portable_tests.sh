#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/native-portable-tests.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
CXX="${CXX:-c++}"
FLAGS=(-std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include")

"$CXX" "${FLAGS[@]}" "$ROOT/tests/looper_core_tests.cpp" "$ROOT/src/looper_core.cpp" "$ROOT/src/dsp_primitives.cpp" -o "$BUILD_DIR/looper_core_tests"
"$BUILD_DIR/looper_core_tests"

"$CXX" "${FLAGS[@]}" "$ROOT/tests/dsp_primitives_tests.cpp" "$ROOT/src/dsp_primitives.cpp" -o "$BUILD_DIR/dsp_primitives_tests"
"$BUILD_DIR/dsp_primitives_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_audio_pipeline_tests.cpp" \
  "$ROOT/src/looper_core.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  -o "$BUILD_DIR/native_audio_pipeline_tests"
"$BUILD_DIR/native_audio_pipeline_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests/support" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_audio_callback_tests.cpp" \
  "$ROOT/src/native_audio_core.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  -o "$BUILD_DIR/native_audio_callback_tests"
"$BUILD_DIR/native_audio_callback_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror \
  -I"$ROOT/tests/support" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_catalog_route_tests.cpp" \
  "$ROOT/src/native_audio_core.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_catalog_route_tests"
"$BUILD_DIR/native_catalog_route_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_g2b_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_g2b_processor_tests"
"$BUILD_DIR/native_g2b_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_pitch_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  -o "$BUILD_DIR/native_pitch_processor_tests"
"$BUILD_DIR/native_pitch_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_poly_pitch_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  -o "$BUILD_DIR/native_poly_pitch_processor_tests"
"$BUILD_DIR/native_poly_pitch_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_chorus_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_chorus_processor_tests"
"$BUILD_DIR/native_chorus_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_phaser_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_phaser_processor_tests"
"$BUILD_DIR/native_phaser_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_flanger_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_flanger_processor_tests"
"$BUILD_DIR/native_flanger_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_dynamics_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  -o "$BUILD_DIR/native_dynamics_processor_tests"
"$BUILD_DIR/native_dynamics_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_fdn16_reverb_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_fdn16_reverb_processor_tests"
"$BUILD_DIR/native_fdn16_reverb_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_distortion_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_distortion_processor_tests"
"$BUILD_DIR/native_distortion_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_preamp_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_preamp_processor_tests"
"$BUILD_DIR/native_preamp_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_beat_repeat_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_beat_repeat_processor_tests"
"$BUILD_DIR/native_beat_repeat_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_roll_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_roll_processor_tests"
"$BUILD_DIR/native_roll_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_freeze_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  -o "$BUILD_DIR/native_freeze_processor_tests"
"$BUILD_DIR/native_freeze_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_beat_scatter_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_beat_scatter_processor_tests"
"$BUILD_DIR/native_beat_scatter_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_tape_echo_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_tape_echo_processor_tests"
"$BUILD_DIR/native_tape_echo_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_reverse_delay_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_reverse_delay_processor_tests"
"$BUILD_DIR/native_reverse_delay_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_autopan_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_autopan_processor_tests"
"$BUILD_DIR/native_autopan_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_fx_catalog_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_fx_catalog_tests"
"$BUILD_DIR/native_fx_catalog_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_synth_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_synth_processor_tests"
"$BUILD_DIR/native_synth_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_manual_pan_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_manual_pan_processor_tests"
"$BUILD_DIR/native_manual_pan_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_isolator_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_isolator_processor_tests"
"$BUILD_DIR/native_isolator_processor_tests"

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_stereo_enhance_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_stereo_enhance_processor_tests"
"$BUILD_DIR/native_stereo_enhance_processor_tests"

"$CXX" "${FLAGS[@]}" "$ROOT/tests/native_rhythm_tests.cpp" "$ROOT/src/native_rhythm_engine.cpp" -o "$BUILD_DIR/native_rhythm_tests"
"$BUILD_DIR/native_rhythm_tests"

if [[ "${RUN_BENCHMARK:-0}" == "1" ]]; then
  "$CXX" "${FLAGS[@]}" \
    "$ROOT/tests/native_audio_bench.cpp" \
    "$ROOT/src/native_rhythm_engine.cpp" \
    "$ROOT/src/native_output_stage.cpp" \
    "$ROOT/src/native_fdn16_reverb_processor.cpp" \
    "$ROOT/src/native_distortion_processor.cpp" \
    "$ROOT/src/native_beat_repeat_processor.cpp" \
    "$ROOT/src/native_roll_processor.cpp" \
    "$ROOT/src/native_beat_scatter_processor.cpp" \
    "$ROOT/src/native_tape_echo_processor.cpp" \
    "$ROOT/src/native_reverse_delay_processor.cpp" \
    "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
    "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
    "$ROOT/src/native_flanger_processor.cpp" \
    "$ROOT/src/native_dynamics_processor.cpp" \
    "$ROOT/src/native_stereo_enhance_processor.cpp" \
    "$ROOT/src/native_chorus_processor.cpp" \
    "$ROOT/src/native_phaser_processor.cpp" \
    "$ROOT/src/dsp_primitives.cpp" \
    "$ROOT/src/looper_core.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
    -o "$BUILD_DIR/native_audio_bench"
  "$BUILD_DIR/native_audio_bench"
fi

"$CXX" "${FLAGS[@]}" \
  "$ROOT/tests/native_mod_delay_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  -o "$BUILD_DIR/native_mod_delay_processor_tests"
"$BUILD_DIR/native_mod_delay_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_osc_voc_core_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  -o "$BUILD_DIR/native_osc_voc_core_tests"
"$BUILD_DIR/native_osc_voc_core_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_osc_voc_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_osc_voc_processor_tests"
"$BUILD_DIR/native_osc_voc_processor_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_osc_bot_core_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  -o "$BUILD_DIR/native_osc_bot_core_tests"
"$BUILD_DIR/native_osc_bot_core_tests"

"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete \
  -I"$ROOT/tests" -I"$ROOT/include" -I"$ROOT/third_party/signalsmith/include" \
  "$ROOT/tests/native_osc_bot_processor_tests.cpp" \
  "$ROOT/tests/native_alloc_tracker.cpp" \
  "$ROOT/src/native_panning_delay_processor.cpp" \
  "$ROOT/src/native_mod_delay_processor.cpp" \
  "$ROOT/src/native_fx_catalog.cpp" \
  "$ROOT/src/native_electric_processor.cpp" \
  "$ROOT/src/native_osc_voc_core.cpp" \
  "$ROOT/src/native_osc_voc_processor.cpp" \
  "$ROOT/src/native_osc_bot_core.cpp" \
  "$ROOT/src/native_osc_bot_processor.cpp" \
  "$ROOT/src/native_vocoder_core.cpp" \
  "$ROOT/src/native_freeze_processor.cpp" \
  "$ROOT/src/native_g2b_processor.cpp" \
  "$ROOT/src/native_preamp_processor.cpp" \
  "$ROOT/src/native_vinyl_flick_processor.cpp" \
  "$ROOT/src/native_beat_scatter_processor.cpp" \
  "$ROOT/src/native_flanger_processor.cpp" \
  "$ROOT/src/native_dynamics_processor.cpp" \
  "$ROOT/src/native_stereo_enhance_processor.cpp" \
  "$ROOT/src/native_autopan_processor.cpp" \
  "$ROOT/src/native_phaser_processor.cpp" \
  "$ROOT/src/native_output_stage.cpp" \
  "$ROOT/src/native_fdn16_reverb_processor.cpp" \
  "$ROOT/src/native_distortion_processor.cpp" \
  "$ROOT/src/native_beat_repeat_processor.cpp" \
  "$ROOT/src/native_roll_processor.cpp" \
  "$ROOT/src/native_tape_echo_processor.cpp" \
  "$ROOT/src/native_reverse_delay_processor.cpp" \
  "$ROOT/src/native_chorus_processor.cpp" \
  "$ROOT/src/native_rhythm_engine.cpp" \
  "$ROOT/src/native_pitch_processor.cpp" \
  "$ROOT/src/native_poly_pitch_processor.cpp" \
  "$ROOT/src/dsp_primitives.cpp" \
  "$ROOT/src/looper_core.cpp" \
  -o "$BUILD_DIR/native_osc_bot_processor_tests"
"$BUILD_DIR/native_osc_bot_processor_tests"

printf 'All portable Native audio tests passed.\n'
