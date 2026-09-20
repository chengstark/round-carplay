import { useCallback, useEffect, useState } from 'react'
import { AudioCommand, AudioData, decodeTypeMap } from '../../../main/carplay/messages'
import { PcmPlayer } from 'pcm-ringbuf-player'
import { AudioPlayerKey, CarPlayWorker } from './worker/types'
import { createAudioPlayerKey } from './worker/utils'
import { useCarplayStore } from '../store/store'

const useCarplayAudio = (worker: CarPlayWorker) => {
  const [audioPlayers] = useState(new Map<AudioPlayerKey, PcmPlayer>())
  const audioVolume = useCarplayStore(s => s.settings?.audioVolume ?? 1.0)
  const navVolume = useCarplayStore(s => s.settings?.navVolume ?? 0.5)
  const outputGain = useCarplayStore(s => s.settings?.outputGain ?? 10)

  useEffect(() => {
    audioPlayers.forEach((player, key) => {
      if (key.includes('navi') || key.endsWith('2') || key.endsWith('3')) {
        player.volume(navVolume * outputGain)
      } else {
        player.volume(audioVolume * outputGain)
      }
    })
  }, [audioVolume, navVolume, outputGain, audioPlayers])

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
      player.volume(configuredVolume * outputGain)

      return player
    },
    [audioPlayers, worker, audioVolume, navVolume, outputGain]
  )

  const processAudio = useCallback(
    (audio: AudioData) => {
      const player = getAudioPlayer(audio)
      console.log('[Audio] decodeType:', audio.decodeType, 'audioType:', audio.audioType, 'command:', audio.command, '(', getCommandName(audio.command), ')')

      if (audio.command === AudioCommand.AudioNaviStart) {
        setTimeout(() => player.volume(navVolume * outputGain), 10)
      } else if (audio.volumeDuration && typeof audio.volume === 'number') {
        const isNav = audio.audioType === 2 || audio.audioType === 3
        const configuredVolume = isNav ? navVolume : audioVolume
        player.volume(
          audio.volume * configuredVolume * outputGain,
          audio.volumeDuration
        )
      }
    },
    [audioVolume, getAudioPlayer, navVolume, outputGain]
  )

  useEffect(() => {
    return () => {
      audioPlayers.forEach(p => p.stop())
    }
  }, [audioPlayers])

  return { processAudio, getAudioPlayer }
}

export default useCarplayAudio
