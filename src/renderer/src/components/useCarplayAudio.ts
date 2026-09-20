import { useCallback, useEffect, useState } from 'react'
import { AudioCommand, AudioData, decodeTypeMap } from '../../../main/carplay/messages'
import { PcmPlayer } from 'pcm-ringbuf-player'
import { AudioPlayerKey, CarPlayWorker } from './worker/types'
import { createAudioPlayerKey } from './worker/utils'
import { useCarplayStore } from '../store/store'

// Web Audio gain is linear: 1 is unity gain, so 10 provides the requested
// tenfold software preamp while the settings sliders remain normalized 0–1.
const SOFTWARE_OUTPUT_GAIN = 10

const useCarplayAudio = (worker: CarPlayWorker) => {
  const [audioPlayers] = useState(new Map<AudioPlayerKey, PcmPlayer>())
  const audioVolume = useCarplayStore(s => s.settings?.audioVolume ?? 1.0)
  const navVolume = useCarplayStore(s => s.settings?.navVolume ?? 0.5)

  useEffect(() => {
    audioPlayers.forEach((player, key) => {
      if (key.includes('navi') || key.endsWith('2') || key.endsWith('3')) {
        player.volume(navVolume * SOFTWARE_OUTPUT_GAIN)
      } else {
        player.volume(audioVolume * SOFTWARE_OUTPUT_GAIN)
      }
    })
  }, [audioVolume, navVolume, audioPlayers])

  const getCommandName = (cmd?: number) => {
    if (typeof cmd === 'number' && cmd in AudioCommand) {
      return AudioCommand[cmd as unknown as keyof typeof AudioCommand]
    }
    return undefined
  }

  const getAudioPlayer = useCallback(
    (audio: AudioData): PcmPlayer => {
      const { decodeType, audioType } = audio
      const format = decodeTypeMap[decodeType]
      const audioKey = createAudioPlayerKey(decodeType, audioType)

      let player = audioPlayers.get(audioKey)
      if (!player) {
        player = new PcmPlayer(format.frequency, format.channel)
        audioPlayers.set(audioKey, player)
        player.start()
        worker.postMessage({
          type: 'audioPlayer',
          payload: {
            sab: player.sab,
            decodeType,
            audioType,
          },
        })
      }

      const isNav = audioType === 2 || audioType === 3
      const configuredVolume = isNav ? navVolume : audioVolume
      player.volume(configuredVolume * SOFTWARE_OUTPUT_GAIN)

      return player
    },
    [audioPlayers, worker, audioVolume, navVolume]
  )

  const processAudio = useCallback(
    (audio: AudioData) => {
      const player = getAudioPlayer(audio)
      console.log('[Audio] decodeType:', audio.decodeType, 'audioType:', audio.audioType, 'command:', audio.command, '(', getCommandName(audio.command), ')')

      if (audio.command === AudioCommand.AudioNaviStart) {
        setTimeout(() => player.volume(navVolume * SOFTWARE_OUTPUT_GAIN), 10)
      } else if (audio.volumeDuration && typeof audio.volume === 'number') {
        const isNav = audio.audioType === 2 || audio.audioType === 3
        const configuredVolume = isNav ? navVolume : audioVolume
        player.volume(
          audio.volume * configuredVolume * SOFTWARE_OUTPUT_GAIN,
          audio.volumeDuration
        )
      }
    },
    [audioVolume, getAudioPlayer, navVolume]
  )

  useEffect(() => {
    return () => {
      audioPlayers.forEach(p => p.stop())
    }
  }, [audioPlayers])

  return { processAudio, getAudioPlayer }
}

export default useCarplayAudio
