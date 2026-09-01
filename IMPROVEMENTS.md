# NEXUS Recent Improvements & Changelog

This document summarizes the major feature upgrades, bug fixes, and architectural improvements made to the NEXUS Agent.

## 1. Automated YouTube Playback
- **Direct Video Execution**: Upgraded the `youtube_play` command logic to automatically play the top/first full-size YouTube video rather than just opening the search results page or defaulting to Shorts. 

## 2. Multi-Intent Routine Parsing
- **Conjunction Splitting**: The agent can now parse complex, rambling sentences containing multiple commands (e.g., *"open YouTube videos and then display the news and check my repositories"*).
- **Phrase Extraction**: Sentences are split by natural conjunctions (*"and then"*, *"also"*, *"after that"*, *"and"*) and processed into distinct, actionable intents.
- **Dynamic Fallback Execution**: Unrecognized actions (like *"display the news"*) are seamlessly routed to the fallback LLM via the Cloudflare Worker instead of failing, ensuring robust execution.

## 3. Conversational Routine Builder Loop
- **Continuous Listening**: When updating a routine, the system now automatically keeps the microphone open. 
- **Interactive Prompts**: After ingesting a command, the agent confirms addition and interactively asks, *"Would you like me to add anything else?"* creating a fluid conversational loop without needing to explicitly wake the agent each time.
- **State Machine Escape Hatch**: Users can break out of the update loop instantly by issuing an execution command (e.g., *"start my morning routine"*). The agent intelligently pivots from "Update" mode to "Execute" mode.

## 4. One-Shot Direct Routine Execution
- **Frictionless Triggers**: Removed the redundant confirmation menus (e.g., *"Which would you like to start, or should I do all of them?"*).
- **Macro-style Execution**: Saying *"Run my morning routine"* now triggers immediate, sequential execution of all saved intents in the background without requiring the user to explicitly say "all".

## 5. Routine Management (Reset / Clear)
- **Memory Wipe Command**: Introduced a new command set to cleanly wipe routines (*"clear my routine"*, *"reset my morning routine"*, *"delete my schedule"*).
- **Seamless Rebuilding**: Clearing a routine immediately transitions the agent back into the "Update" loop so the user can rebuild their schedule from scratch on the spot.

## 6. Audio & TTS (Text-to-Speech) Stability
- **TTS Barge-in Collision Fix**: Implemented a `stopTts()` interrupt to prevent overlapping Rust audio threads when the microphone automatically wakes up.
- **Async Execution Blocks**: Refactored the frontend to strictly `await speak(...)` so the agent finishes speaking completely before triggering the Voice Activity Detection (VAD) loop, preventing audio truncation. 
