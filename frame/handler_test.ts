/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import "jasmine";
import { awaitMessageToPort } from "../lib/shared/messaging";
import {
  FledgeRequest,
  isRunAdAuctionResponse,
  RequestTag,
  RunAdAuctionResponse,
} from "../lib/shared/protocol";
import { assertToBeTruthy, assertToSatisfyTypeGuard } from "../testing/assert";
import {
  FakeRequest,
  FakeServerHandler,
  setFakeServerHandler,
} from "../testing/http";
import { clearStorageBeforeAndAfter } from "../testing/storage";
import { Ad, getAllAds } from "./db_schema";
import { handleRequest } from "./handler";

describe("handleRequest", () => {
  clearStorageBeforeAndAfter();

  const hostname = "www.example.com";

  for (const badInput of [
    undefined,
    [],
    [null],
    [RequestTag.JOIN_AD_INTEREST_GROUP, true],
    [RequestTag.LEAVE_AD_INTEREST_GROUP, 0.02],
    [RequestTag.RUN_AD_AUCTION, []],
  ]) {
    const errorResponse: RunAdAuctionResponse = [false];

    it(`should reply with error message to ${JSON.stringify(
      badInput
    )}`, async () => {
      const { port1: receiver, port2: sender } = new MessageChannel();
      const messageEventPromise = awaitMessageToPort(receiver);
      await expectAsync(
        handleRequest(
          new MessageEvent("message", { data: badInput, ports: [sender] }),
          hostname
        )
      ).toBeRejectedWithError();
      expect((await messageEventPromise).data).toEqual(errorResponse);
    });

    it(`should reply with error message on multiple ports to ${JSON.stringify(
      badInput
    )}`, async () => {
      const { port1: receiver1, port2: sender1 } = new MessageChannel();
      const messageEventPromise1 = awaitMessageToPort(receiver1);
      const { port1: receiver2, port2: sender2 } = new MessageChannel();
      const messageEventPromise2 = awaitMessageToPort(receiver2);
      await expectAsync(
        handleRequest(
          new MessageEvent("message", {
            data: badInput,
            ports: [sender1, sender2],
          }),
          hostname
        )
      ).toBeRejectedWithError();
      expect((await messageEventPromise1).data).toEqual(errorResponse);
      expect((await messageEventPromise2).data).toEqual(errorResponse);
    });
  }

  const name = "interest group name";
  const renderingUrl = "about:blank";
  const ads: Ad[] = [[renderingUrl, 0.02]];
  const joinRequest: FledgeRequest = [
    RequestTag.JOIN_AD_INTEREST_GROUP,
    [name, ads],
  ];
  const joinMessageEvent = new MessageEvent("message", { data: joinRequest });

  it("should join an interest group", async () => {
    await handleRequest(joinMessageEvent, hostname);
    expect([...(await getAllAds())]).toEqual(ads);
  });

  it("should do nothing when joining an interest group with no ads", async () => {
    await handleRequest(joinMessageEvent, hostname);
    const emptyJoinRequest: FledgeRequest = [
      RequestTag.JOIN_AD_INTEREST_GROUP,
      [name, undefined],
    ];
    await handleRequest(
      new MessageEvent("message", { data: emptyJoinRequest }),
      hostname
    );
    expect([...(await getAllAds())]).toEqual(ads);
  });

  it("should leave an interest group", async () => {
    await handleRequest(joinMessageEvent, hostname);
    const leaveRequest: FledgeRequest = [
      RequestTag.LEAVE_AD_INTEREST_GROUP,
      name,
    ];
    await handleRequest(
      new MessageEvent("message", { data: leaveRequest }),
      hostname
    );
    expect([...(await getAllAds())]).toEqual([]);
  });

  it("should run an ad auction", async () => {
    const consoleSpy = spyOnAllFunctions(console);
    await handleRequest(joinMessageEvent, hostname);
    const { port1: receiver, port2: sender } = new MessageChannel();
    const messageEventPromise = awaitMessageToPort(receiver);
    const fakeServerHandler = jasmine
      .createSpy<FakeServerHandler>()
      .and.resolveTo({
        headers: {
          "Content-Type": "application/json",
          "X-Allow-FLEDGE": "true",
        },
        body: '{"a": 1, "b": [true, null]}',
      });
    setFakeServerHandler(fakeServerHandler);
    const trustedScoringSignalsUrl = "https://trusted-server.test/scoring";
    const auctionRequest: FledgeRequest = [
      RequestTag.RUN_AD_AUCTION,
      trustedScoringSignalsUrl,
    ];
    await handleRequest(
      new MessageEvent("message", {
        data: auctionRequest,
        ports: [sender],
      }),
      hostname
    );
    const { data } = await messageEventPromise;
    assertToSatisfyTypeGuard(data, isRunAdAuctionResponse);
    assertToBeTruthy(data[0]);
    assertToBeTruthy(data[1]);
    expect(sessionStorage.getItem(data[1])).toBe(renderingUrl);
    expect(fakeServerHandler).toHaveBeenCalledOnceWith(
      jasmine.objectContaining<FakeRequest>({
        url: new URL(trustedScoringSignalsUrl + "?keys=about%3Ablank"),
        method: "GET",
        hasCredentials: false,
      })
    );
    expect(consoleSpy.error).not.toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
  });
});
