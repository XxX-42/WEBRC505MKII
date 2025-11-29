# Create directories
New-Item -ItemType Directory -Force -Path "src/audio/core"
New-Item -ItemType Directory -Force -Path "src/audio/effects"
New-Item -ItemType Directory -Force -Path "src/audio/worklets"
New-Item -ItemType Directory -Force -Path "src/ui/common"
New-Item -ItemType Directory -Force -Path "src/ui/sections/inputs"
New-Item -ItemType Directory -Force -Path "src/ui/sections/tracks/components"
New-Item -ItemType Directory -Force -Path "src/ui/sections/master/components"
New-Item -ItemType Directory -Force -Path "src/ui/debug/console"
New-Item -ItemType Directory -Force -Path "src/ui/debug/playground"
New-Item -ItemType Directory -Force -Path "src/ui/layout"
New-Item -ItemType Directory -Force -Path "src/ui/components/wrappers"

# Move Audio Core
Get-ChildItem "src/audioEngine/*.ts" | Move-Item -Destination "src/audio/core/" -Force

# Move Audio Effects (Logic)
Get-ChildItem "src/FX/*.ts" | Move-Item -Destination "src/audio/effects/" -Force

# Move Audio Worklets (from public to src/audio/worklets)
# Note: We are moving them from public.
if (Test-Path "public/audio-worklets") {
    Get-ChildItem "public/audio-worklets/*" | Move-Item -Destination "src/audio/worklets/" -Force
}

# Move UI Common
if (Test-Path "src/components/knobs and fader") {
    Get-ChildItem "src/components/knobs and fader/*" | Move-Item -Destination "src/ui/common/" -Force
}

# Move UI Inputs
if (Test-Path "src/components/InterfaceBoard") {
    Get-ChildItem "src/components/InterfaceBoard/*" | Move-Item -Destination "src/ui/sections/inputs/" -Force
}

# Move UI Tracks
if (Test-Path "src/views/TrackBoard.vue") {
    Move-Item "src/views/TrackBoard.vue" -Destination "src/ui/sections/tracks/TrackBoard.vue" -Force
}
if (Test-Path "src/components/TrackBoard") {
    Get-ChildItem "src/components/TrackBoard/*" | Move-Item -Destination "src/ui/sections/tracks/components/" -Force
}

# Move UI Master
if (Test-Path "src/views/MasterBoard.vue") {
    Move-Item "src/views/MasterBoard.vue" -Destination "src/ui/sections/master/MasterBoard.vue" -Force
}
if (Test-Path "src/components/MasterBoard") {
    Get-ChildItem "src/components/MasterBoard/*" | Move-Item -Destination "src/ui/sections/master/components/" -Force
}

# Move UI Debug
if (Test-Path "src/components/console") {
    Get-ChildItem "src/components/console/*" | Move-Item -Destination "src/ui/debug/console/" -Force
}
if (Test-Path "src/views/AudioLinker.vue") {
    Move-Item "src/views/AudioLinker.vue" -Destination "src/ui/debug/AudioGraphDebugger.vue" -Force
}

# Move UI Layout
if (Test-Path "src/views/RC505.vue") {
    Move-Item "src/views/RC505.vue" -Destination "src/ui/layout/MainLayout.vue" -Force
}

# Move UI Playground (FX .vue files)
if (Test-Path "src/FX") {
    Get-ChildItem "src/FX/*.vue" | Move-Item -Destination "src/ui/debug/playground/" -Force
}

# Move UI Wrappers (Audio .vue files)
if (Test-Path "src/audio") {
    Get-ChildItem "src/audio/*.vue" | Move-Item -Destination "src/ui/components/wrappers/" -Force
}

# Cleanup Empty Directories
Remove-Item "src/audioEngine" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "src/FX" -Recurse -Force -ErrorAction SilentlyContinue
# Remove-Item "src/audio" -Recurse -Force -ErrorAction SilentlyContinue # src/audio now contains core/effects/worklets
Remove-Item "src/components/knobs and fader" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "src/components/InterfaceBoard" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "src/components/TrackBoard" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "src/components/MasterBoard" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "src/components/console" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "src/views" -Recurse -Force -ErrorAction SilentlyContinue
