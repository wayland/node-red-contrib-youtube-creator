# FSM plan: Track YouTube Live `status.lifeCycleStatus` (Node-RED)

## Goal

Track a YouTube Live broadcast’s `liveBroadcast.status.lifeCycleStatus` in 
Node-RED using `node-red-contrib-finite-statemachine`.

Source of truth for lifecycle values: the YouTube Live Streaming API 
`liveBroadcast` resource docs (`status.lifeCycleStatus`) at 
[`liveBroadcasts`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts). 
The broadcast “staging” behavior (`testStarting`, `liveStarting`) is also 
described in [Life of a 
Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast).

## Approach (brief)

- Update the FSM as per the YouTube Sync mini-flow, below
- The FSM will be fed desired states that it should be transitioned towards. 
  This will trigger:
  - A state transition towards (but not necessarily into) the state we want, OR
  - An error that says that the YouTube stream is ahead of schedule


### YouTube Sync mini-flow

There should be a mini-flow something that periodically polls the YouTube stream 
and sets the current state in the FSM to the YouTube status using `msg.control= 
sync`.  This skips all the transitions, but keeps the FSM in sync with YouTube.  
* Normal polling interval: Every 20s
* If the current status is a “Starting” one: Every 5s
* If something has been triggered recently, but the expected state hasn’t 
  eventuated: every 5s
* If it’s an expensive query as per 
  https://developers.google.com/youtube/v3/getting-started#quota like a search 
  request: every minute

### FSM States

#### Sequencing

#### Transitions

- Each state defines the transition so that it ends up right back where it 
  started -- the state will only actually change when synced from YouTube
- Each transition should be called "towards_STATE", and the state it's 
  transitioning towards
- Each transaction will have the following data attached:
```
{
	"action": "transition",
	"next_state": "<state name>",
	"goal_state": "<state name>",
}
```
...or...
```
{
	"action": "notice",
	"message": "Stream is ahead of schedule",
}
```

- If a towards_STATE transition would require going backwards in the sequencing, 
  then the action is a "notice" one, as per above.  
- If the towards_STATE transition would require going forward, then the 
  "next_state" is set to the next item in the sequence, and the "goal_state" is 
  set to the state we want to end up in


## FSM JSON (paste into the Node-RED FSM config)

This JSON is structured per the manual for 
`node-red-contrib-finite-statemachine` 
([Manual](https://raw.githubusercontent.com/lutzer/node-red-contrib-finite-statemachine/master/MANUAL.md)).

- **States included**: every documented `status.lifeCycleStatus` value 
  (`created`, `ready`, `testStarting`, `testing`, `liveStarting`, `live`, 
  `complete`, `revoked`).  
- **Also included**: `lifeCycleStatusUnspecified` (seen in some client libraries 
  / “unknown” cases). If you don’t want it, remove the `UNSPECIFIED` state and 
  the `lifeCycleStatusUnspecified` transitions.  

```json
{
  "state": {
    "status": "UNSPECIFIED",
    "data": {
      "source": "youtube.liveBroadcast.status.lifeCycleStatus"
    }
  },
  "transitions": {
    "UNSPECIFIED": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "CREATED": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "READY": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "TESTSTARTING": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "TESTING": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "LIVESTARTING": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "LIVE": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "COMPLETE": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "REVOKED": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    }
  }
}
```

## Notes for the flow wiring

- Drive transitions by setting `msg.topic` to the exact lifecycle string 
  returned by the API (case-sensitive as shown above): `created`, `ready`, 
  `testStarting`, `testing`, `liveStarting`, `live`, `complete`, `revoked` (and 
  optionally `lifeCycleStatusUnspecified`).   
- Use `msg.control = "reset"` to return to initial state, per the node manual.

