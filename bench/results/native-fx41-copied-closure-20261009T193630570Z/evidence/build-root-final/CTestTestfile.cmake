# CMake generated Testfile for 
# Source directory: D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp
# Build directory: C:/Users/user1000/AppData/Local/Temp/webrc-native-fx41-copied-20261010T034000Z
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test("looper_core_tests" "C:/Users/user1000/AppData/Local/Temp/webrc-native-fx41-copied-20261010T034000Z/looper_core_tests.exe")
set_tests_properties("looper_core_tests" PROPERTIES  _BACKTRACE_TRIPLES "D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;105;add_test;D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;0;")
add_test("native_multitrack_core_tests" "C:/Users/user1000/AppData/Local/Temp/webrc-native-fx41-copied-20261010T034000Z/native_multitrack_core_tests.exe")
set_tests_properties("native_multitrack_core_tests" PROPERTIES  _BACKTRACE_TRIPLES "D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;106;add_test;D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;0;")
add_test("native_track_host_tests" "C:/Users/user1000/AppData/Local/Temp/webrc-native-fx41-copied-20261010T034000Z/native_track_host_tests.exe")
set_tests_properties("native_track_host_tests" PROPERTIES  _BACKTRACE_TRIPLES "D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;107;add_test;D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;0;")
add_test("native_fx_graph_tests" "C:/Users/user1000/AppData/Local/Temp/webrc-native-fx41-copied-20261010T034000Z/native_fx_graph_tests.exe")
set_tests_properties("native_fx_graph_tests" PROPERTIES  _BACKTRACE_TRIPLES "D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;108;add_test;D:/Documents/Codes/2024_1_WebRC505MKII/2025_WebRC505MKII_v2/bench/results/native-fx41-copied-closure-20261009T193630570Z/source-snapshot/native-mvp/engine-cpp/CMakeLists.txt;0;")
subdirs("shared_dsp")
subdirs("_deps/rtaudio_src-build")
subdirs("_deps/httplib_src-build")
subdirs("_deps/json_src-build")
