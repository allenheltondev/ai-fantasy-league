/**
 * The global kill switch lives in `@fantasy/server` so the API can show its state to the
 * commissioner (`get_agent_activity`); the agent runtime uses the same implementation.
 */
export {
  OFF_SWITCH,
  ParameterKillSwitch,
  isEngagedValue,
  ssmParameterReader,
  type KillSwitch,
  type ParameterReader
} from '@fantasy/server';
