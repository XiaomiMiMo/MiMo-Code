import { defineMediaReader } from "./read-media"
import DESCRIPTION from "./listen-audio.txt"

export const ListenAudioTool = defineMediaReader("listen_audio", "audio", DESCRIPTION)
