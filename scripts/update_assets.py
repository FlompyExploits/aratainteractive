from pathlib import Path
import re

INDEX_PATH = Path("index.html")

def replace_block(text, pattern, replacement):
    new_text, count = re.subn(pattern, replacement, text, flags=re.S)
    if count != 1:
        raise RuntimeError(f"Expected 1 replacement for pattern, got {count}")
    return new_text


def main():
    text = INDEX_PATH.read_text(encoding="utf-8")

    default_banners = """const defaultBanners = {
            ren: "assets/renbanner.png",
            m1: "assets/m1banner.gif",
            lummy: "assets/lummybanner.gif",
            cazu: "assets/cazubanner.webp",
            sleepy: "assets/sleepybanner.png",
            k: "assets/Kbanner.png",
            zero: "assets/zerobanner.gif",
            aizen: "assets/aizenbanner.gif",
            eli: "assets/elibanner.gif",
            brimo: "assets/brimobanner.jpg"
        };"""

    songs = """const songs = {
            ren: { title: "Mama's Boy", artist: "Dominic Fike", url: "assets/ren_song.mp4" },
            m1: { title: "Asphyxia", artist: "Cö shu Nie", url: "assets/m1_song.mp4" },
            home: { title: "Home", artist: "Jacal", url: "assets/home_song.mp4" },
            lummy: { title: "Jane", artist: "The Long Faces", url: "assets/lummy_song.mp4" },
            sleepy: { title: "Picasso", artist: "Werenoi", url: "assets/sleepy_song.mp4" },
            cazu: { title: "Homesick", artist: "Wave to Earth", url: "assets/cazu_song.mp4" },
            aizen: { title: "Golden Brown", artist: "The Stranglers", url: "assets/aizen_song.mp4", start: 166 },
            eli: { title: "The Honored One", artist: "Gojo Satoru", url: "assets/eli_song.mp4" },
            brimo: { title: "GET IN THE RING", artist: "Max", url: "assets/brimo_song.mp4" }
        };"""

    zero_songs = """const zeroSongs = [
            { title: "ROAR", artist: "Official", url: "assets/zero_song_1.mp4" },
            { title: "Weakest VS Strongest", artist: "Academy City", url: "assets/zero_song_2.mp4" }
        ];"""

    k_songs = """const kSongs = [
            { title: "Chainsaw Man - Trailer OST", artist: "Sacha", url: "assets/k_song_1.mp4", start: 50 },
            { title: "GATE OF STEINER", artist: "Steins;Gate", url: "assets/k_song_2.mp4" },
            { title: "Town, Flow of Time, People", artist: "Clannad", url: "assets/k_song_3.mp4" }
        ];"""

    k_rare = """const kRare = { title: "TALAHON-GHOUL", artist: "Joseph Stakoz Yoresh", url: "assets/k_rare.mp4" };"""

    text = replace_block(text, r"const defaultBanners = \{.*?\};", default_banners)
    text = replace_block(text, r"const songs = \{.*?\};", songs)
    text = replace_block(text, r"const zeroSongs = \[.*?\];", zero_songs)
    text = replace_block(text, r"const kSongs = \[.*?\];", k_songs)
    text = replace_block(text, r"const kRare = \{.*?\};", k_rare)

    INDEX_PATH.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
