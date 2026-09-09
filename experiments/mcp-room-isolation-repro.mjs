#!/usr/bin/env node
// 起動とroom登録の分離は公開API境界試験、通信は実room/client試験で確認する。
import '../skill/scripts/launch-seat.test.mjs'
import '../skill/scripts/room-public-session.test.mjs'
