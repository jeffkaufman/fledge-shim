/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import "jasmine";
import { awaitMessageToPort } from "../lib/shared/messaging";
import {
  isRunAdAuctionResponse,
  messageDataFromRequest,
  RequestKind,
} from "../lib/shared/protocol";
import {
  assertToBeString,
  assertToBeTruthy,
  assertToSatisfyTypeGuard,
} from "../testing/assert";
import {
  FakeRequest,
  FakeServerHandler,
  setFakeServerHandler,
} from "../testing/http";
import { clearStorageBeforeAndAfter } from "../testing/storage";
import { forEachInterestGroup, InterestGroupCallback } from "./db_schema";
import { handleRequest } from "./handler";

describe("handleRequest", () => {
  clearStorageBeforeAndAfter();

  const hostname = "www.example.com";

  for (const badInput of [
    null,
    new Blob(),
    [],
    [undefined],
    [RequestKind.JOIN_AD_INTEREST_GROUP, true],
    [RequestKind.LEAVE_AD_INTEREST_GROUP, 0.02],
    [RequestKind.RUN_AD_AUCTION, []],
  ]) {
    it(`should throw and not reply to ${JSON.stringify(
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
      await expectAsync(messageEventPromise).toBePending();
    });
  }

  const name = "interest group name";
  const trustedBiddingSignalsUrl = "https://trusted-server.test/bidding";
  const renderUrl = "about:blank";
  const ads = [{ renderUrl, metadata: { price: 0.02 } }];
  const group = { name, trustedBiddingSignalsUrl, ads };
  const joinMessageEvent = new MessageEvent("message", {
    data: messageDataFromRequest({
      kind: RequestKind.JOIN_AD_INTEREST_GROUP,
      group,
    }),
  });

  it("should join an interest group", async () => {
    await handleRequest(joinMessageEvent, hostname);
    const callback = jasmine.createSpy<InterestGroupCallback>("callback");
    expect(await forEachInterestGroup(callback)).toBeTrue();
    expect(callback).toHaveBeenCalledOnceWith(group);
  });

  it("should partially overwrite an existing interest group", async () => {
    await handleRequest(joinMessageEvent, hostname);
    const newTrustedBiddingSignalsUrl = "https://trusted-server-2.test/bidding";
    await handleRequest(
      new MessageEvent("message", {
        data: messageDataFromRequest({
          kind: RequestKind.JOIN_AD_INTEREST_GROUP,
          group: {
            name,
            trustedBiddingSignalsUrl: newTrustedBiddingSignalsUrl,
          },
        }),
      }),
      hostname
    );
    const callback = jasmine.createSpy<InterestGroupCallback>("callback");
    expect(await forEachInterestGroup(callback)).toBeTrue();
    expect(callback).toHaveBeenCalledOnceWith({
      name,
      trustedBiddingSignalsUrl: newTrustedBiddingSignalsUrl,
      ads,
    });
  });

  it("should leave an interest group", async () => {
    await handleRequest(joinMessageEvent, hostname);
    await handleRequest(
      new MessageEvent("message", {
        data: messageDataFromRequest({
          kind: RequestKind.LEAVE_AD_INTEREST_GROUP,
          group,
        }),
      }),
      hostname
    );
    const callback = jasmine.createSpy<InterestGroupCallback>("callback");
    expect(await forEachInterestGroup(callback)).toBeTrue();
    expect(callback).not.toHaveBeenCalled();
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
    await handleRequest(
      new MessageEvent("message", {
        data: messageDataFromRequest({
          kind: RequestKind.RUN_AD_AUCTION,
          config: { trustedScoringSignalsUrl },
        }),
        ports: [sender],
      }),
      hostname
    );
    const event = await messageEventPromise;
    assertToBeTruthy(event);
    const { data } = event;
    assertToSatisfyTypeGuard(data, isRunAdAuctionResponse);
    assertToBeString(data);
    expect(sessionStorage.getItem(data)).toBe(renderUrl);
    expect(fakeServerHandler).toHaveBeenCalledTimes(2);
    expect(fakeServerHandler).toHaveBeenCalledWith(
      jasmine.objectContaining<FakeRequest>({
        url: new URL(trustedBiddingSignalsUrl + "?hostname=www.example.com"),
        method: "GET",
        hasCredentials: false,
      })
    );
    expect(fakeServerHandler).toHaveBeenCalledWith(
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
