import {
  query,
  update,
  text,
  Record,
  StableBTreeMap,
  Variant,
  Vec,
  None,
  Some,
  Ok,
  Err,
  ic,
  Principal,
  Opt,
  nat64,
  Duration,
  Result,
  bool,
  Canister,
  init,
} from "azle";
import {
  Ledger,
  binaryAddressFromAddress,
  binaryAddressFromPrincipal,
  hexAddressFromPrincipal,
} from "azle/canisters/ledger";
//@ts-ignore
import { hashCode } from "hashcode";
import { v4 as uuidv4 } from "uuid";

const Room = Record({
  id: text,
  name: text,
  imageUrl: text,
  description: text,
  pricePerNight: nat64,
  isReserved: bool,
  currentReservedTo: Opt(Principal),
  currentReservationEnds: Opt(nat64),
  creator: Principal,
});

const RoomPayload = Record({
  name: text,
  imageUrl: text,
  description: text,
  pricePerNight: nat64,
});

const InitPayload = Record({
  reservationFee: nat64,
});

const OrderStatus = Variant({
  PaymentPending: text,
  Completed: text,
});

const Order = Record({
  roomId: text,
  amount: nat64,
  noOfNights: nat64,
  status: OrderStatus,
  payer: Principal,
  paid_at_block: Opt(nat64),
  memo: nat64,
});

const Message = Variant({
  Booked: text,
  NotBooked: text,
  NotFound: text,
  NotOwner: text,
  InvalidPayload: text,
  PaymentFailed: text,
  PaymentCompleted: text,
});

const roomsStorage = StableBTreeMap(0, text, Room);
const persistedOrders = StableBTreeMap(1, Principal, Order);
const pendingOrders = StableBTreeMap(2, nat64, Order);

// fee to be charged upon room reservation and refunded after room is left
let reservationFee: Opt<nat64> = None;

const ORDER_RESERVATION_PERIOD = 120n; // reservation period in seconds

/* 
    initialization of the Ledger canister. The principal text value is hardcoded because 
    we set it in the `dfx.json`
*/
const icpCanister = Ledger(Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"));

export default Canister({
  // set reservation fee
  initData: init([InitPayload], (payload) => {
    reservationFee = Some(payload.reservationFee);
  }),

  // return rooms reservation fee
  getRooms: query([], Vec(Room), () => {
    return roomsStorage.values();
  }),

  // return orders
  getOrders: query([], Vec(Order), () => {
    return persistedOrders.values();
  }),

  // return pending orders
  getPendingOrders: query([], Vec(Order), () => {
    return pendingOrders.values();
  }),

  // return a particular room
  getRoom: query([text], Result(Room, Message), (id) => {
    const roomOpt = roomsStorage.get(id);
    if ("None" in roomOpt) {
      return Err({ NotFound: `room with id=${id} not found` });
    }
    return Ok(roomOpt.Some);
  }),

  // add new room
  addRoom: update([RoomPayload], Result(Room, Message), (payload) => {
    if (typeof payload !== "object" || Object.keys(payload).length === 0) {
      return Err({ NotFound: "invalid payoad" });
    }
    const room = {
      id: uuidv4(),
      isReserved: false,
      currentReservedTo: None,
      currentReservationEnds: None,
      creator: ic.caller(),
      ...payload,
    };
    roomsStorage.insert(room.id, room);
    return Ok(room);
  }),

  // delete room
  deleteRoom: update([text], Result(text, Message), (id) => {
    // check room before deleting
    const roomOpt = roomsStorage.get(id);
    if ("None" in roomOpt) {
      return Err({
        NotFound: `cannot delete the room: room with id=${id} not found`,
      });
    }

    if (roomOpt.Some.creator.toString() !== ic.caller().toString()) {
      return Err({ NotOwner: "only creator can delete room" });
    }

    if (roomOpt.Some.isReserved) {
      return Err({
        Booked: `room with id ${id} is currently booked`,
      });
    }
    const deletedRoomOpt = roomsStorage.remove(id);

    return Ok(deletedRoomOpt.Some.id);
  }),

  // create order for room reservation
  createReservationOrder: update(
    [text, nat64],
    Result(Order, Message),
    (id, noOfNights) => {
      const roomOpt = roomsStorage.get(id);
      if ("None" in roomOpt) {
        return Err({
          NotFound: `cannot create the order: room=${id} not found`,
        });
      }

      if ("None" in reservationFee) {
        return Err({
          NotFound: "reservation fee not set",
        });
      }

      const room = roomOpt.Some;

      if (room.isReserved) {
        return Err({
          Booked: `room with id ${id} is currently booked`,
        });
      }

      // calculate total amount to be spent plus reservation fee
      let amountToBePaid =
        noOfNights * room.pricePerNight + reservationFee.Some;

      // generate order
      const order = {
        roomId: room.id,
        amount: amountToBePaid,
        noOfNights,
        status: { PaymentPending: "PAYMENT_PENDING" },
        payer: ic.caller(),
        paid_at_block: None,
        memo: generateCorrelationId(id),
      };

      pendingOrders.insert(order.memo, order);

      discardByTimeout(order.memo, ORDER_RESERVATION_PERIOD);

      return Ok(order);
    }
  ),

  // complete room reservation
  completeReservation: update(
    [text, nat64, nat64, nat64],
    Result(Order, Message),
    async (id, noOfNights, block, memo) => {
      // get room
      const roomOpt = roomsStorage.get(id);
      if ("None" in roomOpt) {
        throw Error(`room with id=${id} not found`);
      }

      const room = roomOpt.Some;

      // check reservation fee is set
      if ("None" in reservationFee) {
        return Err({
          NotFound: "reservation fee not set",
        });
      }

      // calculate total amount to be spent plus reservation fee
      let amount = noOfNights * room.pricePerNight + reservationFee.Some;

      // check payments
      const paymentVerified = await verifyPaymentInternal(
        ic.caller(),
        amount,
        block,
        memo
      );

      if (!paymentVerified) {
        return Err({
          NotFound: `cannot complete the purchase: cannot verify the payment, memo=${memo}`,
        });
      }

      const pendingOrderOpt = pendingOrders.remove(memo);
      if ("None" in pendingOrderOpt) {
        return Err({
          NotFound: `cannot complete the purchase: there is no pending order with id=${id}`,
        });
      }

      const order = pendingOrderOpt.Some;
      const updatedOrder = {
        ...order,
        status: { Completed: "COMPLETED" },
        paid_at_block: Some(block),
      };

      // calculate noOfNights in minutes (testing)
      let noOfNightsInMins = noOfNights * BigInt(60 * 1000000000);

      // get updated record
      const updatedRoom = {
        ...room,
        currentReservedTo: Some(ic.caller()),
        isReserved: true,
        currentReservationEnds: Some(ic.time() + noOfNightsInMins),
      };

      roomsStorage.insert(room.id, updatedRoom);
      persistedOrders.insert(ic.caller(), updatedOrder);
      return Ok(updatedOrder);
    }
  ),

  // end reservation and receive your refund
  // complete room reservation
  endReservation: update([text], Result(Message, Message), async (id) => {
    // get room
    const roomOpt = roomsStorage.get(id);
    if ("None" in roomOpt) {
      return Err({ NotFound: `room with id=${id} not found` });
    }

    const room = roomOpt.Some;

    if (!room.isReserved) {
      return Err({ NotBooked: "room is not reserved" });
    }

    if ("None" in room.currentReservationEnds) {
      return Err({ NotBooked: "reservation time not set" });
    }

    if (room.currentReservationEnds.Some > ic.time()) {
      return Err({ Booked: "booking time not yet over" });
    }

    if ("None" in room.currentReservedTo) {
      return Err({ NotBooked: "room not reserved to anyone" });
    }

    if (room.currentReservedTo.Some.toString() !== ic.caller().toString()) {
      return Err({ Booked: "only booker of room can unbook" });
    }

    // check reservation fee is set
    if ("None" in reservationFee) {
      return Err({
        NotFound: "reservation fee not set",
      });
    }

    const result = await makePayment(ic.caller(), reservationFee.Some);

    if ("Err" in result) {
      return result;
    }

    // get updated record
    const updatedRoom = {
      ...room,
      currentReservedTo: None,
      isReserved: false,
      currentReservationEnds: None,
    };

    roomsStorage.insert(room.id, updatedRoom);

    return result;
  }),

  // a helper function to get canister address from the principal
  getCanisterAddress: query([], text, () => {
    let canisterPrincipal = ic.id();
    return hexAddressFromPrincipal(canisterPrincipal, 0);
  }),

  // a helper function to get address from the principal
  getAddressFromPrincipal: query([Principal], text, (principal) => {
    return hexAddressFromPrincipal(principal, 0);
  }),

  // returns the reservation fee
  getReservationFee: query([], nat64, () => {
    if ("None" in reservationFee) {
      return BigInt(0);
    }
    return reservationFee.Some;
  }),
});

/*
    a hash function that is used to generate correlation ids for orders.
    also, we use that in the verifyPayment function where we check if the used has actually paid the order
*/
function hash(input: any): nat64 {
  return BigInt(Math.abs(hashCode().value(input)));
}

// a workaround to make uuid package work with Azle
globalThis.crypto = {
  // @ts-ignore
  getRandomValues: () => {
    let array = new Uint8Array(32);

    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }

    return array;
  },
};

// to process refund of reservation fee to users.
async function makePayment(address: Principal, amount: nat64) {
  const toAddress = hexAddressFromPrincipal(address, 0);
  const transferFeeResponse = await ic.call(icpCanister.transfer_fee, {
    args: [{}],
  });
  const transferResult = ic.call(icpCanister.transfer, {
    args: [
      {
        memo: 0n,
        amount: {
          e8s: amount - transferFeeResponse.transfer_fee.e8s,
        },
        fee: {
          e8s: transferFeeResponse.transfer_fee.e8s,
        },
        from_subaccount: None,
        to: binaryAddressFromAddress(toAddress),
        created_at_time: None,
      },
    ],
  });
  if ("Err" in transferResult) {
    return Err({ PaymentFailed: `refund failed, err=${transferResult.Err}` });
  }
  return Ok({ PaymentCompleted: "refund completed" });
}

function generateCorrelationId(productId: text): nat64 {
  const correlationId = `${productId}_${ic.caller().toText()}_${ic.time()}`;
  return hash(correlationId);
}

/*
    after the order is created, we give the `delay` amount of minutes to pay for the order.
    if it's not paid during this timeframe, the order is automatically removed from the pending orders.
*/
function discardByTimeout(memo: nat64, delay: Duration) {
  ic.setTimer(delay, () => {
    const order = pendingOrders.remove(memo);
    console.log(`Order discarded ${order}`);
  });
}

async function verifyPaymentInternal(
  sender: Principal,
  amount: nat64,
  block: nat64,
  memo: nat64
): Promise<bool> {
  const blockData = await ic.call(icpCanister.query_blocks, {
    args: [{ start: block, length: 1n }],
  });
  const tx = blockData.blocks.find((block) => {
    if ("None" in block.transaction.operation) {
      return false;
    }
    const operation = block.transaction.operation.Some;
    const senderAddress = binaryAddressFromPrincipal(sender, 0);
    const receiverAddress = binaryAddressFromPrincipal(ic.id(), 0);
    return (
      block.transaction.memo === memo &&
      hash(senderAddress) === hash(operation.Transfer?.from) &&
      hash(receiverAddress) === hash(operation.Transfer?.to) &&
      amount === operation.Transfer?.amount.e8s
    );
  });
  return tx ? true : false;
}
