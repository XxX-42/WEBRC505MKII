#include "project_archive_codec.hpp"

#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using webrc::native::DecodedProjectArchive;
using webrc::native::ProjectArchiveTrackData;

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

std::vector<std::uint8_t> readFile(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("could not open archive input");
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void writeFile(const std::string& path, const std::vector<std::uint8_t>& bytes) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("could not open archive output");
    output.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!output) throw std::runtime_error("could not write archive output");
}

void assertTypescriptFixture(const std::string& path) {
    const auto decoded = webrc::native::decodeProjectArchive(readFile(path));
    require(decoded.project.has_value(), "C++ rejected the TypeScript v2 archive");
    const auto& project = *decoded.project;
    require(project.version == 2U, "TypeScript archive was not v2");
    require(project.name == "TS interop", "TypeScript project name changed");
    require(project.tracks[0].has_value() && project.tracks[0]->originalTempoBpm == 93.5,
        "C++ did not read TypeScript originalTempoBpm");
    require(project.tracks[0]->pcm == std::vector<float>({0.25F, -0.5F, 1.0F}),
        "C++ did not preserve TypeScript Float32 PCM");
    require(project.tracks[1].has_value() && !project.tracks[1]->originalTempoBpm,
        "C++ did not preserve TypeScript null originalTempoBpm");
}

void writeCppFixture(const std::string& path) {
    DecodedProjectArchive project;
    project.name = "C++ interop";
    project.bpm = 120.0;
    ProjectArchiveTrackData track;
    track.sampleRate = 48000U;
    track.frameCount = 3U;
    track.channels = 1U;
    track.originalTempoBpm = 87.25;
    track.pcm = {0.5F, -0.25F, 0.125F};
    project.tracks[0] = track;
    track.frameCount = 2U;
    track.channels = 2U;
    track.originalTempoBpm.reset();
    track.pcm = {1.0F, -1.0F, 0.75F, -0.75F};
    project.tracks[1] = track;
    writeFile(path, webrc::native::encodeProjectArchive(project));
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 3) throw std::runtime_error("usage: project_archive_codec_interop <read-ts-v2|write-cpp-v2> <path>");
        const std::string command = argv[1];
        if (command == "read-ts-v2") assertTypescriptFixture(argv[2]);
        else if (command == "write-cpp-v2") writeCppFixture(argv[2]);
        else throw std::runtime_error("unknown interop command");
        std::cout << command << " passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Project archive interop failed: " << error.what() << '\n';
        return 1;
    }
}
