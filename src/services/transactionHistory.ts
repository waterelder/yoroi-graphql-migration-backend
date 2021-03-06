import axios from "axios";

import {  assertNever, contentTypeHeaders, errMsgs, graphqlEndpoint, UtilEither} from "../utils";

import { rowToCertificate, BlockEra, BlockFrag, Certificate, TransInputFrag, TransOutputFrag, TransactionFrag} from "../Transactions/types";

import { Pool } from "pg";




/**
  Everything else in this repo is using graphql, so why psql here?
  Hasura and the rest of the GraphQL start are _slow_ for this sort of thing.
  The psql query generated by Hasura for the equiv GraphQL does several layers
  of lateral joins.  On my machine, such queries can take as long as 41s to run.
  This SQL is fast, averaging about 10ms (though, clearly, the time scales poorly
  with the number of results, as you can see by the subqueries in the select clause.
  As we anticipate cardano-graphql being able to handle this in the future, I have
  left the interface to match what graphql would do.  For posterity's sake, I have
  also left the original GraphQL query in this file. 
  Beware! The GraphQL query never passed tests, and doesn't pull blockindex/tx_ordinal/tx_index.
**/
const askTransactionSqlQuery = `
  with
    hashes as (
      select distinct hash
      from (
            select tx.hash as hash
            FROM tx
            JOIN tx_in 
              ON tx_in.tx_in_id = tx.id
            JOIN tx_out source_tx_out 
              ON tx_in.tx_out_id = source_tx_out.tx_id 
             AND tx_in.tx_out_index::smallint = source_tx_out.index::smallint
            JOIN tx source_tx 
              ON source_tx_out.tx_id = source_tx.id
            WHERE source_tx_out.address = ANY(($1)::varchar array)
               OR source_tx_out.payment_cred = ANY(($5)::bytea array)
            union
            select tx.hash as hash
            from tx
            join tx_out
              on tx.id = tx_out.tx_id
            where tx_out.address = ANY(($1)::varchar array)
               or tx_out.payment_cred = ANY(($5)::bytea array)
            union
            select tx.hash as hash
            from tx 
            join combined_certificates as certs 
              on tx.id = certs."txId" 
            where certs."formalType" in ('CertRegKey', 'CertDeregKey','CertDelegate')
              and certs."stakeCred" = any(($1)::varchar array)
            union
            select tx.hash as hash
            from tx
            join withdrawal as w
            on tx.id = w."tx_id"
            join stake_address as addr
            on w.addr_id = addr.id
            where addr.hash_raw = any(($5)::bytea array)
           ) hashes
    )
  select tx.hash
       , tx.fee
       , tx.block_index as "txIndex"
       , block.block_no as "blockNumber"
       , block.hash as "blockHash"
       , block.epoch_no as "blockEpochNo"
       , block.slot_no as "blockSlotNo"
       , block.epoch_slot_no as "blockSlotInEpoch"
       , case when vrf_key is null then 'byron' 
              else 'shelley' end 
         as blockEra
       , block.time at time zone 'UTC' as "includedAt"
       , (select json_agg(( source_tx_out.address
                          , source_tx_out.value
                          , encode(source_tx.hash, 'hex')
                          , tx_in.tx_out_index) order by tx_in.id asc) as inAddrValPairs
          FROM tx inadd_tx
          JOIN tx_in
            ON tx_in.tx_in_id = inadd_tx.id
          JOIN tx_out source_tx_out 
            ON tx_in.tx_out_id = source_tx_out.tx_id AND tx_in.tx_out_index::smallint = source_tx_out.index::smallint
          JOIN tx source_tx 
            ON source_tx_out.tx_id = source_tx.id
          where inadd_tx.hash = tx.hash) as "inAddrValPairs"
       , (select json_agg(("address", "value") order by "index" asc)  as outAddrValPairs
          from "TransactionOutput" hasura_to
          where hasura_to."txHash" = tx.hash) as "outAddrValPairs"
       , (select json_agg((encode(addr."hash_raw",'hex'), "amount") order by w."id" asc)
          from withdrawal as w
          join stake_address as addr
          on addr.id = w.addr_id
          where tx_id = tx.id) as withdrawals
       , pool_meta_data.hash as metadata
       , (select json_agg(row_to_json(combined_certificates) order by "certIndex" asc)
          from combined_certificates 
          where "txId" = tx.id) as certificates
                            
  from tx
  join hashes
    on hashes.hash = tx.hash
  join block
    on block.id = tx.block
  left join pool_meta_data 
    on tx.id = pool_meta_data.registered_tx_id 
  where     block.block_no <= $2
        and block.block_no > $3 
  order by block.time asc, tx.block_index asc
  limit $4;
`;

const graphQLQuery = `
  query TxsHistory(
    $addresses: [String]
    $limit: Int
    $afterBlockNum: Int
    $untilBlockNum: Int
  ) {
    transactions(
      where: {
        _and: [
          { block: { number: { _gte: $afterBlockNum, _lte: $untilBlockNum } } }
          {
            _or: [
              { inputs: { address: { _in: $addresses } } }
              { outputs: { address: { _in: $addresses } } }
            ]
          }
        ]
      }
      limit: $limit
      order_by: { includedAt: asc }
    ) {
      hash
  
      block {
        number
        hash
        epochNo
        slotNo
      }
      includedAt
      inputs {
        address
        value
      }
      outputs {
        address
        value
      }
    }
  }
`;

const MAX_INT = "2147483647";

const HEX_LENGTH = 56;

const HEX_REGEXP = RegExp('^[0-9a-fA-F]+$')

export const askTransactionHistory = async ( 
  pool: Pool
  , limit: number
  , addresses: string[]
  , afterNum: UtilEither<BlockNumByTxHashFrag>
  , untilNum: UtilEither<number>) : Promise<UtilEither<TransactionFrag[]>> => {
  const paymentCreds = addresses.filter((s:string) => s.length === HEX_LENGTH && HEX_REGEXP.test(s))
                                .map((s:string) => `\\x${s}`);
  const ret = await pool.query(askTransactionSqlQuery, [ addresses
    , untilNum.kind === "ok" ? untilNum.value : 0
    , afterNum.kind === "ok" ? afterNum.value.block.number : 0
    , limit
    , paymentCreds]);
  const txs = ret.rows.map( (row: any):TransactionFrag => {
    const inputs = row.inAddrValPairs 
      ? row.inAddrValPairs.map( ( obj:any ): TransInputFrag => 
        ({ address: obj.f1
          , amount: obj.f2.toString() 
          , id: obj.f3.concat(obj.f4.toString())
          , index: obj.f4
          , txHash: obj.f3}))
      : []; 
    const outputs = row.outAddrValPairs 
      ? row.outAddrValPairs.map( ( obj:any ): TransOutputFrag => ({ address: obj.f1, amount: obj.f2.toString() }))
      : [];
    const withdrawals : TransOutputFrag[] = row.withdrawals 
      ? row.withdrawals.map( ( obj:any ): TransOutputFrag => ({ address: obj.f1, amount: obj.f2.toString() })) 
      : [];
    const certificates = row.certificates !== null
      ? row.certificates
        .map(rowToCertificate) 
        .filter( (i:Certificate|null) => i !== null)
      : [];
    const blockFrag : BlockFrag = { number: row.blockNumber
      , hash: row.blockHash.toString("hex")
      , epochNo: row.blockEpochNo
      , slotNo: row.blockSlotInEpoch };
    return { hash: row.hash.toString("hex")
      , block: blockFrag
      , fee: row.fee.toString()
      , metadata: (row.metadata) ? row.metadata.toString("hex") : null
      , includedAt: row.includedAt
      , inputs: inputs
      , outputs: outputs
      , ttl: MAX_INT
      , blockEra: row.blockEra === "byron" ? BlockEra.Byron : BlockEra.Shelley
      , txIndex: row.txIndex
      , withdrawals: withdrawals
      , certificates: certificates
    };
  });
            

  return { kind: "ok", value: txs } ;
  //if('data' in ret && 'data' in ret.data && 'transactions' in ret.data.data)
  //    return {'kind':'ok', value:ret.data.data.transactions};
  //else
  //    return {'kind':'error', errMsg:'TxsHistory, could not understand graphql response'};


};

interface BlockNumByTxHashFrag {
  block: BlockByTxHashFrag;
  hash: string;
}
interface BlockByTxHashFrag {
  hash: string;
  number: number;
}
export const askBlockNumByTxHash = async (hash : string|undefined): Promise<UtilEither<BlockNumByTxHashFrag>> => {
  if(!hash)
    return {kind:"error", errMsg: errMsgs.noValue};
  const query = `
            query BlockNumByTxHash($hashId: Hash32HexString!) {
              transactions(
                where: {
                  hash: {
                    _eq: $hashId
                  }
                }
              ) {
                hash
                block {
                  number
                  hash
                }
              }
            }`;
  let ret = null;
  try {
    ret = (await axios.post(graphqlEndpoint,
      JSON.stringify({ "query": query, "variables": {"hashId":hash} }),
      contentTypeHeaders));
  } catch (err) {
    return { kind: "error", errMsg: "askBlockNumByTxHash, unable to query graphql service: " + err };
  }
  if("data" in ret 
       && "data" in ret.data 
       && "transactions" in ret.data.data
       && Array.isArray(ret.data.data.transactions))
    if(   ret.data.data.transactions.length > 0
         && "block" in ret.data.data.transactions[0]
         && "hash" in ret.data.data.transactions[0].block
         && "number" in ret.data.data.transactions[0].block)
         
      return {kind:"ok", value:ret.data.data.transactions[0]};
    else
      return { kind:"error", errMsg: errMsgs.noValue };
  else 
    return {kind:"error", errMsg: "Did not understand graphql response"};
} ;

export const askBlockNumByHash = async (hash : string) : Promise<UtilEither<number>> => {
  const query = `
            query BlockNumByHash($id: Hash32HexString!) {
              blocks(
                where: {
                  hash: {
                    _eq: $id
                  }
                }
              ) {
                number
              }
            }
    `;
  let ret = null;
  try {
    ret = await axios.post(graphqlEndpoint,
      JSON.stringify({ "query": query, "variables": {"id":hash} }),
      contentTypeHeaders);
  } catch (err) {
    return { kind:"error", errMsg: "askBlockNumByHash, unable to query graphql service: " + err };
  }
  if("data" in ret 
       && "data" in ret.data 
       && "blocks" in ret.data.data
       && Array.isArray(ret.data.data.blocks))
    if(   ret.data.data.blocks.length > 0 
         && "number" in ret.data.data.blocks[0])
      return {kind:"ok", value:ret.data.data.blocks[0].number};
    else
      return { kind:"error", errMsg: errMsgs.noValue };
  else 
    return {kind:"error", errMsg: "askBlockNumByHash, Did not understand graphql response"};

};
