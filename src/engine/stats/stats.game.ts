import { GameState } from "../GameWorker";
import { Stats } from "./stats.common";

export function writeGameWorkerStats(state: GameState, frameDuration: number) {
  state.statsBuffer.f32[Stats.gameTime] = state.time.dt;
  state.statsBuffer.f32[Stats.gameDuration] = frameDuration;
}

export function StatsModule() {}
